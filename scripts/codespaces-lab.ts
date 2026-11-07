/** Isolated, provider-free development lab; never loads the user's OpenCode profile. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repository = resolve(import.meta.dir, "..");
const lab = join(repository, ".sidebar-lab");
const command = process.argv[2];
assert(
  command === "start" || command === "fresh" || command === "verify",
  "Use bun run lab:start, lab:fresh, or lab:verify.",
);
assert(process.platform === "linux", "This development lab targets Linux/Codespaces.");
assert.equal(Bun.version, "1.3.14", "Use the pinned Bun 1.3.14 toolchain.");
const binary = process.env.OPENCODE_BIN ?? Bun.which("opencode");
assert(binary, "OpenCode is missing. Rebuild the dev container or set OPENCODE_BIN.");
const executable = await realpath(binary);
await mkdir(lab, { recursive: true, mode: 0o700 });

function isolatedEnvironment(root: string): Record<string, string> {
  // No inherited auth, provider keys, OPENCODE_CONFIG*, GitHub tokens, or user settings.
  return {
    PATH: process.env.PATH ?? "",
    TERM: process.env.TERM ?? "xterm-256color",
    COLORTERM: "truecolor",
    LANG: "C.UTF-8",
    HOME: join(root, "home"),
    OPENCODE_TEST_HOME: join(root, "home"),
    OPENCODE_TEST_MANAGED_CONFIG_DIR: join(root, "managed"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    GIT_CONFIG_NOSYSTEM: "true",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
}

async function run(args: string[], env: Record<string, string>, cwd = repository) {
  const child = Bun.spawn(args, {
    cwd,
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  assert.equal(code, 0, `${args.join(" ")} exited with ${code}.`);
}

async function createProfile() {
  const id = randomUUID();
  const temporary = join(lab, `current-${id}.tmp`);
  await writeFile(temporary, JSON.stringify({ id }) + "\n", { mode: 0o600 });
  await rename(temporary, join(lab, "current.json"));
  return id;
}

async function currentProfile() {
  const raw = await readFile(join(lab, "current.json"), "utf8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (!raw) return createProfile();
  const profile = JSON.parse(raw) as { id?: unknown };
  assert(
    typeof profile.id === "string" &&
      /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(profile.id),
    "Invalid lab profile. Run bun run lab:fresh to select a new isolated profile.",
  );
  return profile.id;
}

if (command === "fresh") {
  const id = await createProfile();
  console.log(
    `Selected fresh lab profile ${id}. Previous profiles remain in .sidebar-lab/profiles/.`,
  );
  console.log(
    "Run bun run lab:start. Close any older lab terminal before starting the new profile.",
  );
} else if (command === "verify") {
  const report = join(lab, "reports", `${Date.now()}-${randomUUID()}`);
  await mkdir(report, { recursive: true, mode: 0o700 });
  const env: Record<string, string> = {
    ...isolatedEnvironment(join(report, "tool-home")),
    OPENCODE_BIN: executable,
    SIDEBAR_SMOKE_REPORT: join(report, "sidebar.json"),
    SIDEBAR_ATTENTION_REPORT: join(report, "attention.json"),
    SIDEBAR_SMOKE_FRAMES: join(report, "sidebar-frames.json"),
    SIDEBAR_ATTENTION_FRAMES: join(report, "attention-frames.json"),
    SIDEBAR_PACKAGE_REPORT: join(report, "package.json"),
  };
  await mkdir(env.HOME!, { recursive: true });
  console.log(`Lab verification reports: ${report}`);
  await run([process.execPath, "run", "check"], env);
  await run([process.execPath, "run", "smoke:sidebar"], env);
  await run([process.execPath, "run", "smoke:sidebar:attention"], env);
  await run([process.execPath, "run", "smoke:package"], env);
  console.log(`Lab verification passed. Reports: ${report}`);
  console.log(
    "This checks the stock host in a PTY; manually check the browser terminal separately.",
  );
} else {
  const id = await currentProfile();
  const root = join(lab, "profiles", id);
  const env = isolatedEnvironment(root);
  const project = join(root, "project");
  const config = join(root, "config", "opencode");
  await Promise.all(
    [
      "home",
      "managed",
      "data",
      "cache",
      "state",
      "sidebar-state",
      "project",
      "config/opencode",
    ].map((path) => mkdir(join(root, path), { recursive: true, mode: 0o700 })),
  );
  const version = Bun.spawn([executable, "--version"], { cwd: project, env, stdout: "pipe" });
  assert.equal((await new Response(version.stdout).text()).trim(), "1.18.30");
  assert.equal(await version.exited, 0);
  // A nested plain directory would inherit the source checkout's Git project and instructions.
  // Give this synthetic project its own root without touching the source repository's Git data.
  if (!(await Bun.file(join(project, ".git", "HEAD")).exists())) {
    await run(
      ["git", "init", "--initial-branch=lab", `--template=${env.OPENCODE_TEST_MANAGED_CONFIG_DIR}`],
      env,
      project,
    );
    await writeFile(
      join(project, "README.md"),
      "# Synthetic sidebar lab\n\nDisposable session organization trial.\n",
    );
    await run(["git", "add", "--", "README.md"], env, project);
    await run(
      [
        "git",
        "-c",
        "user.name=Sidebar lab",
        "-c",
        "user.email=sidebar-lab@example.invalid",
        "commit",
        "--no-verify",
        "--no-gpg-sign",
        "-m",
        "Initialize synthetic lab project",
      ],
      env,
      project,
    );
  }
  const plugin = join(repository, "dist", "tui.js");
  assert(await Bun.file(plugin).exists(), "Build this checkout first: bun run build.");
  await writeFile(
    join(config, "opencode.json"),
    JSON.stringify({ autoupdate: false, share: "disabled", enabled_providers: [] }, null, 2) + "\n",
    { mode: 0o600 },
  );
  await writeFile(
    join(config, "tui.json"),
    JSON.stringify(
      {
        plugin: [
          [
            pathToFileURL(plugin).href,
            {
              hostId: `sidebar-lab-${id}`,
              storageDirectory: join(root, "sidebar-state"),
              density: "balanced",
              icons: "ascii",
            },
          ],
        ],
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  console.log("OpenCode lab: no external providers; separate sessions, config, and sidebar state.");
  console.log("Close Connect a provider with Esc, then click new session + and enter a title.");
  console.log("Exit with /exit. Restart this profile with bun run lab:start.");
  await run([executable], env, project);
}
