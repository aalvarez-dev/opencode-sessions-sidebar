/** Load the organization service in two real stock TUI processes and verify restart hydration. */
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const expectedVersion = "1.18.30";
const binary = process.env.OPENCODE_BIN;
assert(binary, "Set OPENCODE_BIN to an installed stock OpenCode 1.18.30 binary.");
assert(process.platform !== "win32", "The stock TUI restart probe requires a POSIX PTY.");
const executable = await realpath(binary);
const root = await mkdtemp(join(tmpdir(), "sidebar-organization-smoke-"));
const project = join(root, "project");
const config = join(root, "config");
const storage = join(root, "sidebar-state");
const expected = join(root, "write-result.json");
const lifecycle = new AbortController();
let child: ReturnType<typeof Bun.spawn> | undefined;
const timeout = setTimeout(() => {
  lifecycle.abort(new Error("Organization restart probe exceeded 100 seconds."));
  child?.kill("SIGKILL");
}, 100_000);

async function stopChild() {
  if (!child) return;
  child.kill("SIGKILL");
  await child.exited;
  child.terminal?.close();
  child = undefined;
}

try {
  // V1's managed preferences bypass OPENCODE_TEST_MANAGED_CONFIG_DIR on macOS.
  // Detect their presence without opening them or modifying host configuration.
  if (process.platform === "darwin") {
    for (const path of [
      "/Library/Managed Preferences/ai.opencode.managed.plist",
      join("/Library/Managed Preferences", userInfo().username, "ai.opencode.managed.plist"),
    ]) {
      const managed = await lstat(path).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      });
      assert(!managed, "Use an unmanaged test host for this isolated probe.");
    }
  }
  await Promise.all([
    mkdir(project),
    mkdir(join(root, "home")),
    mkdir(join(root, "managed")),
    mkdir(join(config, "opencode"), { recursive: true }),
  ]);
  await writeFile(join(config, "opencode", "opencode.json"), "{}");
  // The child receives no inherited provider credentials or personal configuration.
  const env = {
    PATH: process.env.PATH ?? "",
    OPENCODE_TEST_HOME: join(root, "home"),
    OPENCODE_TEST_MANAGED_CONFIG_DIR: join(root, "managed"),
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
  };
  child = Bun.spawn([executable, "--version"], {
    cwd: project,
    env,
    stdout: "pipe",
    stderr: "pipe",
    signal: lifecycle.signal,
  });
  assert(child.stdout && typeof child.stdout !== "number");
  assert.equal((await new Response(child.stdout).text()).trim(), expectedVersion);
  assert.equal(await child.exited, 0);
  child = undefined;

  const plugin = join(root, "organization-probe.mjs");
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "organization-probe.ts")],
    target: "bun",
    format: "esm",
  });
  assert(build.success && build.outputs[0], "Could not build the temporary organization probe.");
  await Bun.write(plugin, build.outputs[0]);
  await writeFile(
    join(config, "opencode", "tui.json"),
    JSON.stringify({ plugin: [pathToFileURL(plugin).href] }),
  );

  for (const phase of ["write", "read"] as const) {
    const output = phase === "write" ? expected : join(root, "read-result.json");
    child = Bun.spawn([executable], {
      cwd: project,
      env: {
        ...env,
        TERM: "xterm-256color",
        LANG: "C.UTF-8",
        SIDEBAR_ORGANIZATION_PHASE: phase,
        SIDEBAR_ORGANIZATION_OUTPUT: output,
        SIDEBAR_ORGANIZATION_EXPECTED: expected,
        SIDEBAR_ORGANIZATION_DIRECTORY: project,
        // A caller-owned local directory, never a path inferred from a remote host.
        SIDEBAR_ORGANIZATION_STORAGE: storage,
      },
      terminal: {
        cols: 140,
        rows: 40,
        data(terminal, data) {
          const output = new TextDecoder().decode(data);
          // Reply to terminal capability queries without submitting a user prompt.
          if (output.includes("\u001b]11;?"))
            terminal.write("\u001b]11;rgb:0000/0000/0000\u001b\\");
          if (output.includes("\u001b[6n")) terminal.write("\u001b[1;1R");
        },
      },
    });
    const started = performance.now();
    while (!(await Bun.file(output).exists())) {
      lifecycle.signal.throwIfAborted();
      assert(child.exitCode === null, `Stock TUI exited before the ${phase} probe completed.`);
      assert(performance.now() - started < 45_000, `Stock TUI ${phase} probe timed out.`);
      await Bun.sleep(20);
    }
    const result: {
      passed: boolean;
      version?: string;
      phase?: string;
      message?: string;
      replayEvents?: number;
    } = await Bun.file(output).json();
    assert(result.passed, result.message ?? `Stock TUI ${phase} probe failed.`);
    assert.equal(result.version, expectedVersion);
    assert.equal(result.phase, phase);
    assert.equal(result.replayEvents, 0);
    // A new stock TUI process must read the committed file; no in-memory service survives.
    await stopChild();
  }
  console.log(
    `Stock OpenCode ${expectedVersion}: organization restart probe passed (two real TUI processes, native session IDs, pins, completion, Later order, zero hydration events, stale-command rejection).`,
  );
  console.log(
    "No model inference. This validates headless organization persistence, not sidebar rendering or crash/power-loss durability.",
  );
} finally {
  clearTimeout(timeout);
  lifecycle.abort();
  await stopChild();
  await rm(root, { recursive: true, force: true });
}
