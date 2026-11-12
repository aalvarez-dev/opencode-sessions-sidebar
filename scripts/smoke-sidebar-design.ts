/** Actual stock OpenCode rendering of the explicit synthetic approved-design fixture. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { checkDesign, type DesignSnapshot } from "./check-sidebar-design";
import { designAgentConfig, designLimitations } from "./sidebar-design-fixture";
import { startGraphicalTerminal, type GraphicalTerminal } from "./lib/graphical-terminal";

assert(process.env.OPENCODE_BIN, "Set OPENCODE_BIN to stock OpenCode 1.18.30.");
const executable = await realpath(process.env.OPENCODE_BIN);
const repo = resolve(import.meta.dir, "..");
const product = await realpath(process.env.SIDEBAR_PLUGIN_FILE ?? join(repo, "dist/tui.js"));
const root = await mkdtemp(join(tmpdir(), "sidebar-approved-design-"));
const project = join(root, "opencode-sessions-sidebar");
const config = join(root, "config");
const storage = join(root, "sidebar-state");
const exchange = join(root, "exchange");
const output = resolve(process.env.SIDEBAR_DESIGN_DIR ?? ".sidebar-lab/approved-design");
const reportPath = resolve(process.env.SIDEBAR_DESIGN_REPORT ?? join(output, "design.json"));
const graphicalOutput = process.env.SIDEBAR_GRAPHICAL_DIR;
let graphical: GraphicalTerminal | undefined;
let child: ReturnType<typeof Bun.spawn> | undefined;
let outputTail = "";
let requestId = 0;
const lifetime = new AbortController();
const deadline = setTimeout(() => {
  lifetime.abort(new Error("Design fixture deadline exceeded."));
  child?.kill("SIGKILL");
}, 120_000);
const sourcePaths = [
  "dist/tui.js",
  "src/ui/end-label.tsx",
  "src/ui/icons.ts",
  "src/ui/colors.ts",
  "src/ui/view.tsx",
  "scripts/sidebar-design-fixture.ts",
  "scripts/sidebar-design-wrapper.ts",
  "scripts/sidebar-probe.ts",
  "scripts/check-sidebar-design.ts",
  "scripts/smoke-sidebar-design.ts",
];
const hashes = async () =>
  Object.fromEntries(
    await Promise.all(
      sourcePaths.map(async (path) => [
        path,
        createHash("sha256")
          .update(await readFile(join(repo, path)))
          .digest("hex"),
      ]),
    ),
  );
type Snapshot = DesignSnapshot & {
  plugins: { id: string; active: boolean }[];
  route: { name: string; params?: { sessionID?: string } };
  initialIds: string[];
};
const allText = (snapshot: Snapshot) =>
  snapshot.frame.lines.map((line) => line.map((span) => span.text).join("")).join("\n");
async function pause() {
  lifetime.signal.throwIfAborted();
  await Bun.sleep(25);
}
async function request<T>(type: string): Promise<T> {
  const id = ++requestId;
  await writeFile(`${exchange}.request.tmp`, JSON.stringify({ id, type }));
  await rename(`${exchange}.request.tmp`, `${exchange}.request.json`);
  const started = performance.now();
  for (;;) {
    lifetime.signal.throwIfAborted();
    assert(child?.exitCode === null, `Native design process exited: ${outputTail}`);
    const raw = await readFile(`${exchange}.response.json`, "utf8").catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (raw) {
      const response = JSON.parse(raw);
      if (response.id === id) {
        assert(response.ok, response.error);
        return response.result;
      }
    }
    assert(performance.now() - started < 15_000, `Design request ${type} timed out: ${outputTail}`);
    await pause();
  }
}
async function until(predicate: (snapshot: Snapshot) => boolean) {
  const started = performance.now();
  let snapshot: Snapshot;
  do {
    snapshot = await request<Snapshot>("snapshot");
    if (predicate(snapshot)) return snapshot;
    await pause();
  } while (performance.now() - started < 15_000);
  throw new Error(`Expected design frame did not appear.\n${allText(snapshot)}`);
}
function input(sequence: string) {
  if (graphical) graphical.input(sequence);
  else {
    assert(child?.terminal);
    child.terminal.write(sequence);
  }
}
try {
  await mkdir(output, { recursive: true });
  await Promise.all(
    [project, join(config, "opencode"), join(root, "home"), join(root, "managed")].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  const git = Bun.spawn(["git", "init", "--initial-branch", "feat/continuista-sidebar", project], {
    stdout: "ignore",
    stderr: "pipe",
  });
  assert.equal(await git.exited, 0);
  const observer = join(root, "observer.mjs");
  const wrapper = join(root, "design-wrapper.mjs");
  for (const [entry, target] of [
    ["sidebar-probe.ts", observer],
    ["sidebar-design-wrapper.ts", wrapper],
  ] as const) {
    const built = await Bun.build({
      entrypoints: [join(import.meta.dir, entry)],
      target: "bun",
      format: "esm",
    });
    assert(built.success && built.outputs[0], `Could not build ${entry}: ${built.logs.join("\n")}`);
    await Bun.write(target, built.outputs[0]);
  }
  await writeFile(
    join(config, "opencode/opencode.json"),
    JSON.stringify({ agent: designAgentConfig }),
  );
  await writeFile(
    join(config, "opencode/tui.json"),
    JSON.stringify({
      plugin: [
        [
          pathToFileURL(wrapper).href,
          {
            hostId: "synthetic-sidebar-runtime",
            storageDirectory: storage,
            icons: "nerd",
            density: "balanced",
            reducedMotion: true,
          },
        ],
        pathToFileURL(observer).href,
      ],
    }),
  );
  const env = {
    PATH: process.env.PATH ?? "",
    TERM: "xterm-256color",
    LANG: "C.UTF-8",
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
    SIDEBAR_SMOKE_EXCHANGE: exchange,
    SIDEBAR_SMOKE_DIRECTORY: project,
    SIDEBAR_SMOKE_STORAGE: storage,
    SIDEBAR_DESIGN: "true",
    SIDEBAR_DESIGN_PRODUCT: product,
  };
  const sourceHashes = await hashes();
  const wrapperSha256 = createHash("sha256")
    .update(await readFile(wrapper))
    .digest("hex");
  if (graphicalOutput) {
    graphical = await startGraphicalTerminal({
      executable,
      cwd: project,
      env,
      cols: 140,
      rows: 48,
      theme: "dark",
      directory: graphicalOutput,
      label: "approved-design",
    });
    child = graphical.process;
  } else
    child = Bun.spawn([executable], {
      cwd: project,
      env,
      terminal: {
        cols: 140,
        rows: 48,
        data(terminal, data) {
          const output = new TextDecoder().decode(data);
          outputTail = (outputTail + output).slice(-12000);
          if (output.includes("\u001b]10;?"))
            terminal.write("\u001b]10;rgb:ffff/ffff/ffff\u001b\\");
          if (output.includes("\u001b]11;?"))
            terminal.write("\u001b]11;rgb:0000/0000/0000\u001b\\");
          if (output.includes("\u001b[6n")) terminal.write("\u001b[1;1R");
        },
      },
    });
  const start = performance.now();
  while (!(await Bun.file(`${exchange}.ready.json`).exists())) {
    assert(child.exitCode === null, `Design observer failed to load: ${outputTail}`);
    assert(performance.now() - start < 45_000, `Design observer failed to start: ${outputTail}`);
    await pause();
  }
  await request("seed");
  let snapshot = await until(
    (s) =>
      s.route.params?.sessionID === s.design.ids.release && allText(s).includes("Active session:"),
  );
  // Close native onboarding only through its visible button, never by editing host storage.
  if (allText(snapshot).includes("Getting started")) {
    const lines = snapshot.frame.lines.map((line) => line.map((span) => span.text).join(""));
    const y = lines.findIndex((line) => line.includes("Getting started"));
    const x = lines[y]?.indexOf("✕") ?? -1;
    assert(x >= 0, "Native onboarding close control is not visible.");
    input(`\u001b[<0;${x + 1};${y + 1}M\u001b[<0;${x + 1};${y + 1}m`);
    snapshot = await until((s) => !allText(s).includes("Getting started"));
  }
  snapshot = await until((s) =>
    s.geometry.some((n) => n.id === `sidebar-child-${s.design.ids.backend}` && n.height === 1),
  );
  const framePath = join(output, "approved-design-frame.json");
  await writeFile(framePath, JSON.stringify(snapshot, null, 2) + "\n");
  const acceptance = checkDesign(snapshot);
  const capture = graphical ? await graphical.capture("approved-design") : undefined;
  assert.deepEqual(await hashes(), sourceHashes, "Measured sources changed during design capture.");
  assert.equal(
    snapshot.design.productSha256,
    createHash("sha256")
      .update(await readFile(product))
      .digest("hex"),
  );
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        status: "passed",
        nativeExecutionValidated: false,
        scope: "Actual stock-TUI renderer with deterministic synthetic public-read inputs",
        acceptance,
        sourceHashes,
        wrapperSha256,
        frame: framePath,
        geometry: { columns: snapshot.frame.width, rows: snapshot.frame.height },
        pixelCapture: capture ?? null,
        graphical: graphical?.metadata() ?? null,
        limitations: designLimitations,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `Approved-design stock-TUI fixture passed ${acceptance.checks.length} geometry/color checks; real pixel capture: ${Boolean(capture)}.`,
  );
} catch (error) {
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "failure-output.log"), outputTail);
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        status: "failed",
        nativeExecutionValidated: false,
        error: String(error),
        limitations: designLimitations,
      },
      null,
      2,
    ) + "\n",
  );
  throw error;
} finally {
  clearTimeout(deadline);
  lifetime.abort();
  if (graphical) await graphical.close();
  else if (child) {
    child.kill("SIGKILL");
    await child.exited;
    child.terminal?.close();
  }
  await rm(root, { recursive: true, force: true });
}
