/** Validate the distributable in a fresh consumer without the checkout's dependencies. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const repository = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
assert(
  args.length === 0 || (args.length === 1 && args[0] === "--runtime"),
  "Use package:check or smoke:package.",
);
assert.equal(Bun.version, "1.3.14", "Use the pinned Bun 1.3.14 toolchain.");
const runtime = args[0] === "--runtime";
if (runtime) {
  assert(process.platform !== "win32", "Stock-host package smoke requires a POSIX PTY.");
  assert(process.env.OPENCODE_BIN, "Set OPENCODE_BIN to stock OpenCode 1.18.30.");
}
const npm = Bun.which("npm");
assert(npm, "npm is required to create and install the local package archive.");
const root = await mkdtemp(join(tmpdir(), "sidebar-package-check-"));
const consumer = join(root, "consumer");
const home = join(root, "home");
const packageName = "opencode-sessions-sidebar";
const installed = join(consumer, "node_modules", packageName);
const env: Record<string, string> = {
  PATH: process.env.PATH ?? "",
  HOME: home,
  USERPROFILE: home,
  TMPDIR: root,
  TEMP: root,
  TMP: root,
  TERM: "xterm-256color",
  LANG: "C.UTF-8",
  npm_config_cache: join(root, "npm-cache"),
  npm_config_userconfig: join(root, "empty-npmrc"),
  npm_config_globalconfig: join(root, "empty-global-npmrc"),
  npm_config_ignore_scripts: "true",
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_offline: "true",
  ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
};
const checks: string[] = [];
const receipt: Record<string, unknown> = {
  kind: "fresh-local-package-install",
  status: "running",
  runtimeRequested: runtime,
  platform: process.platform,
  arch: process.arch,
  bun: Bun.version,
  checks,
};

async function run(command: string[], cwd: string, extra: Record<string, string> = {}) {
  const child = Bun.spawn(command, {
    cwd,
    env: { ...env, ...extra },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), runtime ? 240_000 : 90_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    assert.equal(code, 0, `${command[0]} failed (${code}):\n${stderr}\n${stdout}`);
    return stdout;
  } finally {
    clearTimeout(timer);
  }
}

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function packagePath(path: string): boolean {
  if (
    isAbsolute(path) ||
    path.includes("\\") ||
    path.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith("."))
  )
    return false;
  return (
    ["package.json", "README.md", "CHANGELOG.md", "LICENSE", "examples/README.md"].includes(path) ||
    /^(dist|assets\/fonts|docs)\//.test(path) ||
    /^examples\/[a-z0-9-]+\.mjs$/.test(path)
  );
}

async function filesBelow(directory: string, prefix = ""): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    assert(!entry.isSymbolicLink(), `Unexpected symlink in installed package: ${name}`);
    if (entry.isDirectory()) result.push(...(await filesBelow(join(directory, entry.name), name)));
    else {
      assert(entry.isFile(), `Unexpected special file in installed package: ${name}`);
      result.push(name);
    }
  }
  return result.sort();
}

try {
  await Promise.all([mkdir(consumer), mkdir(home)]);
  await writeFile(join(root, "empty-npmrc"), "");
  await writeFile(join(root, "empty-global-npmrc"), "");
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  assert(
    (await lstat(join(repository, "dist", "tui.js"))).isFile(),
    "Build this checkout before packaging.",
  );
  const packed = JSON.parse(
    await run([npm, "pack", "--json", "--ignore-scripts", "--pack-destination", root], repository),
  ) as {
    filename: string;
    files: { path: string; size: number }[];
  }[];
  assert.equal(packed.length, 1);
  const pack = packed[0]!;
  assert(/^[a-zA-Z0-9._-]+\.tgz$/.test(pack.filename), "Unexpected package archive name.");
  assert(pack.files.length > 0 && pack.files.length <= 500, "Unexpected package file count.");
  assert(
    pack.files.every((file) => packagePath(file.path)),
    "Package contains files outside its explicit distribution boundary.",
  );
  assert(
    pack.files.reduce((sum, file) => sum + file.size, 0) <= 25 * 1024 * 1024,
    "Package exceeds the 25 MiB development artifact budget.",
  );
  const paths = new Set(pack.files.map((file) => file.path));
  for (const required of [
    "package.json",
    "LICENSE",
    "README.md",
    "dist/tui.js",
    "dist/tui.d.ts",
    "dist/prepare-fonts.js",
    "assets/fonts/manifest.json",
    "docs/release.md",
    "docs/terminal-fonts.md",
    "examples/report-preview.mjs",
    "examples/completion-observer.mjs",
  ]) {
    assert(paths.has(required), `Package is missing ${required}.`);
  }
  checks.push("explicit-package-contents");
  const archive = join(root, pack.filename);
  receipt.archive = {
    name: pack.filename,
    sha256: hash(await readFile(archive)),
    files: pack.files.length,
  };
  await run(
    [
      npm,
      "install",
      "--offline",
      "--ignore-scripts",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      archive,
    ],
    consumer,
  );
  const installedFiles = await filesBelow(installed);
  assert.deepEqual(
    installedFiles,
    [...paths].sort(),
    "Installed artifact differs from the packed file list.",
  );
  assert.deepEqual(
    (await readdir(join(consumer, "node_modules"))).filter((name) => !name.startsWith(".")),
    [packageName],
    "Fresh consumer unexpectedly installed runtime or development dependencies.",
  );
  checks.push("offline-consumer-install-without-development-dependencies");
  const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8")) as {
    name: string;
    version: string;
    private: boolean;
    dependencies?: Record<string, string>;
    exports: Record<string, { import: string; types: string }>;
  };
  assert.equal(manifest.name, packageName);
  assert.equal(
    manifest.private,
    true,
    "Package validation must not remove the development publication guard.",
  );
  assert.equal(
    Object.keys(manifest.dependencies ?? {}).length,
    0,
    "Host runtimes must not become package runtime dependencies.",
  );
  for (const [name, target] of Object.entries(manifest.exports)) {
    assert(name === "." || name.startsWith("./"), "Unexpected export name.");
    for (const path of [target.import, target.types]) {
      assert(
        path.startsWith("./dist/") && paths.has(path.slice(2)),
        `Missing packaged export: ${name} -> ${path}`,
      );
    }
  }
  const probe = join(consumer, "probe.mjs");
  await writeFile(
    probe,
    `
import assert from "node:assert/strict";
import { createCompletionState } from "opencode-sessions-sidebar";
import { createV1Adapter } from "opencode-sessions-sidebar/adapters/opencode-v1";
import { createOrganizationService } from "opencode-sessions-sidebar/organization";
import { createExtensionRuntime, parseExtensionConfigs } from "opencode-sessions-sidebar/extensions";
import { createFileStorage } from "opencode-sessions-sidebar/storage/file";
assert.equal(createCompletionState("synthetic").done, false);
assert.equal(typeof createV1Adapter, "function");
assert.equal(typeof createOrganizationService, "function");
assert.equal(typeof createExtensionRuntime, "function");
assert.deepEqual(parseExtensionConfigs(undefined), []);
assert.equal(typeof createFileStorage, "function");
for (const suffix of ${JSON.stringify(Object.keys(manifest.exports).map((name) => (name === "." ? "" : name.slice(1))))}) {
  assert(import.meta.resolve("opencode-sessions-sidebar" + suffix).includes("node_modules/opencode-sessions-sidebar/dist/"));
}
console.log("Fresh consumer exports passed.");
`,
  );
  await run([process.execPath, probe], consumer);
  await run([process.execPath, join(installed, "dist", "prepare-fonts.js"), "--help"], consumer);
  const fontConfig = await run(
    [process.execPath, join(installed, "dist", "prepare-fonts.js"), "--config", "ghostty"],
    consumer,
  );
  const fontManifest = JSON.parse(
    await readFile(join(installed, "assets", "fonts", "manifest.json"), "utf8"),
  );
  assert(
    fontConfig.includes(fontManifest.family),
    "Packaged font helper must resolve its own pinned manifest.",
  );
  checks.push(
    "packaged-export-targets-and-independent-headless-imports",
    "packaged-font-helper-without-checkout",
  );
  const digests = Object.fromEntries(
    await Promise.all(
      installedFiles.map(async (path) => [path, hash(await readFile(join(installed, path)))]),
    ),
  );
  assert.equal(
    digests["dist/tui.js"],
    hash(await readFile(join(repository, "dist", "tui.js"))),
    "The installed TUI differs from the checkout's built artifact.",
  );
  receipt.package = { name: manifest.name, version: manifest.version, files: digests };
  const source = Bun.spawn(["git", "rev-parse", "HEAD"], {
    cwd: repository,
    stdout: "pipe",
    stderr: "ignore",
  });
  const commit = (await new Response(source.stdout).text()).trim();
  if ((await source.exited) === 0) receipt.checkoutBaseCommit = commit;
  if (runtime) {
    const native: Record<string, unknown> = {};
    receipt.native = native;
    for (const [script, variable, name] of [
      ["smoke-sidebar.ts", "SIDEBAR_SMOKE_REPORT", "sidebar"],
      ["smoke-sidebar-attention.ts", "SIDEBAR_ATTENTION_REPORT", "attention"],
    ] as const) {
      const report = join(root, `${name}.json`);
      await run([process.execPath, join(repository, "scripts", script)], repository, {
        OPENCODE_BIN: resolve(process.env.OPENCODE_BIN!),
        SIDEBAR_PLUGIN_FILE: join(installed, "dist", "tui.js"),
        [variable]: report,
      });
      native[name] = JSON.parse(
        (await readFile(report, "utf8")).replaceAll(root, "/synthetic/package-check"),
      );
      checks.push(`stock-host-${name}-from-installed-package`);
    }
    assert.equal(
      hash(await readFile(join(installed, "dist", "tui.js"))),
      digests["dist/tui.js"],
      "Installed runtime artifact changed during the host probes.",
    );
  }
  receipt.status = "passed";
  console.log(
    JSON.stringify(
      {
        status: receipt.status,
        archive: receipt.archive,
        package: { name: manifest.name, version: manifest.version, files: installedFiles.length },
        runtimeRequested: runtime,
        checks,
      },
      null,
      2,
    ),
  );
} catch (error) {
  receipt.status = "failed";
  receipt.error = (error instanceof Error ? error.message : String(error)).replaceAll(
    root,
    "/synthetic/package-check",
  );
  console.error(receipt.error);
  process.exitCode = 1;
} finally {
  try {
    if (process.env.SIDEBAR_PACKAGE_REPORT) {
      const report = resolve(process.env.SIDEBAR_PACKAGE_REPORT);
      const path = relative(root, report);
      assert(
        path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path),
        "The report must be outside the temporary consumer.",
      );
      await writeFile(report, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
