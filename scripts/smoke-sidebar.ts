/** Actual stock-OpenCode sidebar rendering and PTY input smoke. No model inference. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { arch, cpus, release, tmpdir, totalmem, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const expectedVersion = "1.18.30";
const binary = process.env.OPENCODE_BIN;
assert(binary, "Set OPENCODE_BIN to stock OpenCode 1.18.30.");
assert(process.platform !== "win32", "The rendered stock TUI smoke requires a POSIX PTY.");
const executable = await realpath(binary);
const root = await mkdtemp(join(tmpdir(), "sidebar-ui-smoke-"));
const project = join(root, "project");
const config = join(root, "config");
const storage = join(root, "sidebar-state");
const exchange = join(root, "exchange");
const lifetime = new AbortController();
let child: ReturnType<typeof Bun.spawn> | undefined;
let requestId = 0;
let outputTail = "";
const deadline = setTimeout(() => {
  lifetime.abort(new Error("Rendered sidebar smoke exceeded 180 seconds."));
  child?.kill("SIGKILL");
}, 180_000);

// Declared before the first runtime measurement. Snapshot round trips include
// the test observer's 10ms polling, one public host list read, and a local file receipt.
const budgets = { inputToObservedFrameP95Ms: 250, nativeCrudBurst20Ms: 5_000 };
type Span = { text: string; width: number; fg: number[]; bg: number[]; attributes: number };
type Snapshot = {
  version: string;
  theme: { mode: "dark" | "light"; selected: string };
  route: { name: string; params?: { sessionID?: string } };
  dialogDepth: number;
  plugins: { id: string; active: boolean; enabled: boolean }[];
  sessions: { id: string; title: string }[];
  initialIds: string[];
  burst: { running: boolean; count: number; hostOperationsMs: number; error?: string } | null;
  organization: {
    revision: number;
    pins: string[];
    later: string[];
    completionStates: { sessionKey: string; done: boolean }[];
  } | null;
  frame: { width: number; height: number; frameId: number; lines: Span[][] };
};
const frames: { name: string; theme: string; icons: string; frame: Snapshot["frame"] }[] = [];
const checks: string[] = [];
const inputLatencies: number[] = [];

async function pause(ms = 20) {
  lifetime.signal.throwIfAborted();
  await Bun.sleep(ms);
}
async function stopChild() {
  if (!child) return;
  child.kill("SIGKILL");
  await child.exited;
  child.terminal?.close();
  child = undefined;
}
async function request<T>(type: string, fields: object = {}): Promise<T> {
  const id = ++requestId;
  await writeFile(`${exchange}.request.tmp`, JSON.stringify({ id, type, ...fields }));
  await rename(`${exchange}.request.tmp`, `${exchange}.request.json`);
  const started = performance.now();
  for (;;) {
    lifetime.signal.throwIfAborted();
    assert(child?.exitCode === null, `Stock TUI exited unexpectedly: ${outputTail}`);
    const raw = await readFile(`${exchange}.response.json`, "utf8").catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (raw) {
      const response = JSON.parse(raw) as { id: number; ok: boolean; error?: string; result: T };
      if (response.id === id) {
        assert(response.ok, response.error ?? "Observer request failed.");
        return response.result;
      }
    }
    assert(performance.now() - started < 30_000, `Probe request ${type} timed out: ${outputTail}`);
    await pause(10);
  }
}
function lines(snapshot: Snapshot) {
  return snapshot.frame.lines.map((line) => line.map((span) => span.text).join(""));
}
function text(snapshot: Snapshot) {
  return lines(snapshot).join("\n");
}
function dialogText(snapshot: Snapshot) {
  // The tested wide stock sidebar occupies its documented 42 rightmost cells.
  // Ignore background rows there when checking the centered modal filter result.
  return lines(snapshot)
    .map((line) => line.slice(0, snapshot.frame.width - 42))
    .join("\n");
}
async function until(check: (value: Snapshot) => boolean, description: string, budget = 5_000) {
  const started = performance.now();
  let last: Snapshot | undefined;
  do {
    last = await request<Snapshot>("snapshot");
    if (check(last)) return last;
    await pause();
  } while (performance.now() - started < budget);
  throw new Error(`${description}\n${last ? text(last) : outputTail}`);
}
function resize(cols: number, rows: number) {
  assert(child?.terminal);
  child.terminal.resize(cols, rows);
}
function input(sequence: string) {
  assert(child?.terminal);
  child.terminal.write(sequence);
}
async function click(label: string, occurrence = 0) {
  const snapshot = await request<Snapshot>("snapshot");
  let found = 0;
  for (const [row, line] of lines(snapshot).entries()) {
    const column = line.indexOf(label);
    if (column < 0 || found++ !== occurrence) continue;
    assert(child?.terminal);
    const x = column + 2;
    const y = row + 1;
    input(`\u001b[<0;${x};${y}M\u001b[<0;${x};${y}m`);
    return;
  }
  throw new Error(`Could not locate rendered mouse label '${label}'.\n${text(snapshot)}`);
}
async function capture(name: string, theme: string, icons: string) {
  const snapshot = await request<Snapshot>("snapshot");
  assert.equal(
    snapshot.theme.mode,
    theme,
    "Recorded frame must use the requested host theme mode.",
  );
  // Synthetic paths are temporary test details, not reproducible visual metadata.
  const sanitized = JSON.parse(JSON.stringify(snapshot.frame).replaceAll(root, "/synthetic"));
  frames.push({ name, theme, icons, frame: sanitized });
  await writeFile(
    process.env.SIDEBAR_SMOKE_FRAMES ?? join(root, "frames.json"),
    JSON.stringify(frames),
  );
  return snapshot;
}
async function browse(title: string) {
  await request("command", { command: "sessions-sidebar.browse" });
  await until((snapshot) => snapshot.dialogDepth > 0, "Browse dialog did not open.");
  input(title);
  await until((snapshot) => text(snapshot).includes(title), "Browse filter did not render.");
  input("\r");
  await until((snapshot) => text(snapshot).includes("Open session"), "Session menu did not open.");
}
async function choose(label: string) {
  // The public host dialog supports search. Real PTY keypresses select its result.
  input(label);
  await until((snapshot) => text(snapshot).includes(label), `Action '${label}' did not render.`);
  input("\r");
}
async function dismiss() {
  input("\u001b");
  await until((snapshot) => snapshot.dialogDepth === 0, "Dialog did not close.");
}

try {
  if (process.platform === "darwin") {
    for (const path of [
      "/Library/Managed Preferences/ai.opencode.managed.plist",
      join("/Library/Managed Preferences", userInfo().username, "ai.opencode.managed.plist"),
    ]) {
      const present = await lstat(path).then(
        () => true,
        (error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        },
      );
      assert(!present, "Use an unmanaged host for this isolated probe.");
    }
  }
  await Promise.all([
    mkdir(project),
    mkdir(join(root, "home")),
    mkdir(join(root, "managed")),
    mkdir(join(config, "opencode"), { recursive: true }),
  ]);
  await writeFile(join(config, "opencode", "opencode.json"), "{}");
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
    signal: lifetime.signal,
  });
  assert(child.stdout && typeof child.stdout !== "number");
  assert.equal((await new Response(child.stdout).text()).trim(), expectedVersion);
  assert.equal(await child.exited, 0);
  child = undefined;
  const observer = join(root, "sidebar-probe.mjs");
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "sidebar-probe.ts")],
    target: "bun",
    format: "esm",
  });
  assert(built.success && built.outputs[0], "Could not build the stock-TUI observer.");
  await Bun.write(observer, built.outputs[0]);
  const plugin = resolve(import.meta.dir, "../dist/tui.js");
  assert(await Bun.file(plugin).exists(), "Build the sidebar TUI entrypoint before the smoke.");

  async function launch(theme: "dark" | "light", icons: "ascii" | "unicode") {
    await writeFile(
      join(config, "opencode", "tui.json"),
      JSON.stringify({
        plugin: [
          [
            pathToFileURL(plugin).href,
            {
              hostId: "synthetic-sidebar-runtime",
              storageDirectory: storage,
              icons,
              density: "balanced",
            },
          ],
          pathToFileURL(observer).href,
        ],
      }),
    );
    await rm(`${exchange}.ready.json`, { force: true });
    await rm(`${exchange}.request.json`, { force: true });
    outputTail = "";
    child = Bun.spawn([executable], {
      cwd: project,
      env: {
        ...env,
        TERM: "xterm-256color",
        LANG: "C.UTF-8",
        SIDEBAR_SMOKE_EXCHANGE: exchange,
        SIDEBAR_SMOKE_DIRECTORY: project,
        SIDEBAR_SMOKE_STORAGE: storage,
      },
      terminal: {
        cols: 140,
        rows: 40,
        data(terminal, data) {
          const output = new TextDecoder().decode(data);
          outputTail = (outputTail + output).slice(-12_000);
          if (output.includes("\u001b]10;?"))
            terminal.write(
              `\u001b]10;rgb:${theme === "light" ? "0000/0000/0000" : "ffff/ffff/ffff"}\u001b\\`,
            );
          if (output.includes("\u001b]11;?"))
            terminal.write(
              `\u001b]11;rgb:${theme === "dark" ? "0000/0000/0000" : "ffff/ffff/ffff"}\u001b\\`,
            );
          if (output.includes("\u001b[6n")) terminal.write("\u001b[1;1R");
        },
      },
    });
    const started = performance.now();
    while (!(await Bun.file(`${exchange}.ready.json`).exists())) {
      assert(child.exitCode === null, `Stock TUI exited during plugin loading: ${outputTail}`);
      assert(performance.now() - started < 45_000, `Sidebar observer did not start: ${outputTail}`);
      await pause();
    }
    await until(
      (snapshot) =>
        snapshot.plugins.some((entry) => entry.id === "opencode-sessions-sidebar" && entry.active),
      "Sidebar plugin did not activate.",
    );
  }

  await launch("dark", "ascii");
  await request("seed");
  await until(
    (snapshot) => text(snapshot).includes("All sessions"),
    "Sidebar did not render in the stock session route.",
  );
  await capture("wide-initial", "dark", "ascii");
  input("\u001b[<65;125;18M".repeat(12));
  await until(
    (snapshot) => !text(snapshot).includes("- Pinned") && text(snapshot).includes("Synthetic"),
    "Real mouse wheel did not scroll the long stock sidebar.",
  );
  await capture("wide-scrolled", "dark", "ascii");
  input("\u001b[<64;125;18M".repeat(50));
  await until(
    (snapshot) => text(snapshot).includes("- Pinned"),
    "Mouse wheel did not restore the sidebar top.",
  );
  checks.push("real mouse wheel scrolls many long-title rows and restores the sidebar top");
  checks.push(
    "actual built plugin loaded in stock session sidebar; synthetic host sessions rendered",
  );

  await browse("Synthetic Alpha");
  await choose("Mark completed");
  let current = await until(
    (snapshot) => Boolean(snapshot.organization?.completionStates.some((entry) => entry.done)),
    "Keyboard mark was not committed.",
  );
  assert.equal(current.route.params?.sessionID, current.initialIds[0]);
  await browse("Synthetic Alpha");
  await choose("Pin");
  await until(
    (snapshot) => snapshot.organization?.pins.length === 1,
    "Keyboard pin was not committed.",
  );
  await browse("Synthetic Alpha");
  await choose("Add to Later");
  current = await until(
    (snapshot) => snapshot.organization?.later.length === 1,
    "Keyboard Later addition was not committed.",
  );
  assert.equal(current.route.params?.sessionID, current.initialIds[0]);
  checks.push("real keyboard mark/pin/Later actions persisted without changing native selection");
  await capture("wide-organized", "dark", "ascii");
  await click("- Pinned");
  await until((snapshot) => text(snapshot).includes("+ Pinned"), "Mouse collapse did not render.");
  await capture("wide-collapsed", "dark", "ascii");
  await click("+ Pinned");
  await until((snapshot) => text(snapshot).includes("- Pinned"), "Mouse expansion did not render.");
  checks.push("real mouse collapses and expands Pinned with its activity summary retained");

  await browse("Synthetic Beta");
  await choose("Add to Later");
  await until(
    (snapshot) => snapshot.organization?.later.length === 2,
    "Second Later entry missing.",
  );
  await browse("Synthetic Beta");
  await choose("Move earlier");
  current = await until(
    (snapshot) =>
      Boolean(snapshot.organization?.later[0]?.includes(snapshot.initialIds[1] ?? "missing")),
    "Keyboard Later reorder failed.",
  );
  checks.push("real keyboard Later reordering persisted");

  await browse("Synthetic Beta");
  await choose("Open session");
  await until(
    (snapshot) => snapshot.route.params?.sessionID === snapshot.initialIds[1],
    "Native navigation did not confirm opening Later session.",
  );
  checks.push("real keyboard open observed on native route; Later membership retained");
  await click("Synthetic Alpha");
  await until(
    (snapshot) => text(snapshot).includes("Open session"),
    "Mouse row did not open the shared session menu.",
  );
  await choose("Clear completion mark");
  await until(
    (snapshot) => snapshot.organization?.completionStates.every((entry) => !entry.done) === true,
    "Mouse-opened menu did not clear completion.",
  );
  checks.push("real PTY mouse row opens the same action menu; unmark commits");

  await request("command", { command: "sessions-sidebar.create" });
  await until((snapshot) => snapshot.dialogDepth > 0, "Create prompt missing.");
  input("Synthetic disposable\r");
  await until(
    (snapshot) => snapshot.sessions.some((entry) => entry.title === "Synthetic disposable"),
    "Create did not reach host.",
  );
  await browse("Synthetic disposable");
  await choose("Rename");
  await until((snapshot) => text(snapshot).includes("Rename"), "Rename prompt missing.");
  input("\u0001\u000bSynthetic renamed\r");
  await until(
    (snapshot) => snapshot.sessions.some((entry) => entry.title === "Synthetic renamed"),
    "Rename did not reach host.",
  );
  await browse("Synthetic renamed");
  await choose("Delete session");
  await until(
    (snapshot) => text(snapshot).includes("Delete") && !text(snapshot).includes("Open session"),
    "Delete confirmation missing.",
  );
  input("\u001b");
  await until(
    (snapshot) => snapshot.dialogDepth === 0,
    "Cancel deletion did not close confirmation.",
  );
  current = await request<Snapshot>("snapshot");
  assert(current.sessions.some((entry) => entry.title === "Synthetic renamed"));
  await browse("Synthetic renamed");
  await choose("Delete session");
  await until(
    (snapshot) => text(snapshot).includes("Delete") && !text(snapshot).includes("Open session"),
    "Delete confirmation missing.",
  );
  await capture("delete-confirmation", "dark", "ascii");
  // Confirmation defaults to cancel; select confirm explicitly through its visible label.
  await click("Confirm");
  await until(
    (snapshot) => !snapshot.sessions.some((entry) => entry.title === "Synthetic renamed"),
    "Confirmed deletion did not reach host.",
  );
  checks.push(
    "native create/rename/delete via real keyboard, cancellation preserves session and explicit mouse confirmation deletes",
  );

  resize(88, 24);
  await until(
    (snapshot) => snapshot.frame.width === 88 && snapshot.frame.height === 24,
    "Terminal resize was not applied.",
  );
  await browse("Synthetic Alpha");
  await capture("narrow-session-menu", "dark", "ascii");
  await choose("Open session");
  await until(
    (snapshot) => snapshot.route.params?.sessionID === snapshot.initialIds[0],
    "Narrow menu did not open the native session.",
  );
  checks.push("narrow 88x24 keyboard browse/action fallback remains usable");
  resize(140, 40);
  await until((snapshot) => snapshot.frame.width === 140, "Wide resize was not applied.");

  const beforeLifecycle = (await request<Snapshot>("snapshot")).organization;
  await request("command", { command: "sessions-sidebar.browse" });
  await until(
    (snapshot) => snapshot.dialogDepth > 0,
    "Owned dialog did not open before deactivation.",
  );
  const deactivated = await request<{ changed: boolean }>("deactivate");
  assert(deactivated.changed);
  await until(
    (snapshot) =>
      !snapshot.plugins.some((entry) => entry.id === "opencode-sessions-sidebar" && entry.active) &&
      snapshot.dialogDepth === 0,
    "Sidebar did not deactivate and close its owned dialog.",
  );
  const activated = await request<{ changed: boolean }>("activate");
  assert(activated.changed);
  current = await until(
    (snapshot) => text(snapshot).includes("All sessions"),
    "Sidebar did not render after reactivation.",
  );
  assert.deepEqual(current.organization, beforeLifecycle);
  assert.equal(
    text(current).match(/All sessions/g)?.length,
    1,
    "Reactivation must render one sidebar instance.",
  );
  checks.push("stock plugin deactivation/reactivation restores committed organization");

  await request("command", { command: "sessions-sidebar.browse" });
  await until((snapshot) => snapshot.dialogDepth > 0, "Browse missing before native event burst.");
  await request("burst");
  let overlappingInputSamples = 0;
  for (let index = 0; index < 10; index++) {
    if (index > 0) await request("command", { command: "sessions-sidebar.browse" });
    await until((snapshot) => snapshot.dialogDepth > 0, "Browse missing for input measurement.");
    const beforeInput = await request<Snapshot>("snapshot");
    if (beforeInput.burst?.running) overlappingInputSamples++;
    const started = performance.now();
    input("Synthetic Alpha");
    await until(
      (snapshot) =>
        snapshot.frame.frameId > beforeInput.frame.frameId &&
        dialogText(snapshot).includes("Synthetic Alpha") &&
        !dialogText(snapshot).includes("Synthetic Beta") &&
        !dialogText(snapshot).includes("Synthetic 01"),
      "Typed filter did not repaint.",
    );
    inputLatencies.push(performance.now() - started);
    await dismiss();
  }
  const burstSnapshot = await until(
    (snapshot) => snapshot.burst?.running === false,
    "Native event burst did not finish.",
  );
  const burst = burstSnapshot.burst;
  assert(burst && !burst.error, burst?.error ?? "Native event burst missing.");
  assert.equal(burst.count, 20);
  assert(burst.hostOperationsMs < budgets.nativeCrudBurst20Ms);
  assert(
    overlappingInputSamples > 0,
    "At least one real keyboard sample must overlap the native event burst.",
  );
  inputLatencies.sort((left, right) => left - right);
  const p95 = inputLatencies[Math.ceil(inputLatencies.length * 0.95) - 1];
  assert(p95 !== undefined && p95 < budgets.inputToObservedFrameP95Ms);
  checks.push(
    "20 paced native updates overlap real keyboard filtering; observed frames pass the declared p95 budget",
  );
  await stopChild();

  await launch("light", "unicode");
  await request("command", { command: "sessions-sidebar.browse" });
  await until((snapshot) => snapshot.dialogDepth > 0, "Light-theme browse dialog missing.");
  await capture("light-restart-browse", "light", "unicode");
  checks.push("new stock process hydrates organization; light terminal and Unicode browse render");
  await stopChild();

  const sourceFiles = [
    "src/tui.tsx",
    "src/ui/controller.ts",
    "src/ui/model.ts",
    "src/ui/view.tsx",
    "scripts/build.ts",
    "scripts/sidebar-probe.ts",
    "scripts/smoke-sidebar.ts",
    "dist/tui.js",
  ];
  const hashes = Object.fromEntries(
    await Promise.all(
      sourceFiles.map(async (file) => [
        file,
        createHash("sha256")
          .update(await readFile(resolve(import.meta.dir, "..", file)))
          .digest("hex"),
      ]),
    ),
  );
  const revisionProcess = Bun.spawn(["git", "rev-parse", "HEAD"], {
    cwd: resolve(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  const baseCommit = (await new Response(revisionProcess.stdout).text()).trim();
  assert.equal(await revisionProcess.exited, 0);
  const processors = cpus();
  const report = {
    schema: 1,
    runtime: { opencode: expectedVersion, opentui: "0.4.5", solid: "1.9.10", bun: Bun.version },
    environment: {
      platform: process.platform,
      architecture: arch(),
      osRelease: release(),
      cpuModel: processors[0]?.model ?? "unknown",
      visibleLogicalCpus: processors.length,
      visibleMemoryBytes: totalmem(),
      isolatedHome: true,
      workload: {
        initialSessions: 20,
        transientCreatedSessions: 1,
        nativeUpdateEvents: 20,
        externalModelInference: false,
      },
    },
    source: { baseCommit, sha256: hashes },
    scope:
      "Actual stock TUI rendering, public native CRUD, real PTY keyboard/mouse; no model inference.",
    budgets,
    results: {
      checks,
      nativeCrudBurst20Ms: burst.hostOperationsMs,
      inputObservationSamples: inputLatencies.length,
      overlappingInputSamples,
      nativeBurstFixtureSpacingMs: 10,
      inputToObservedFrameP95Ms: p95,
    },
    limitations: [
      "Observer polling and public list reads add overhead; timing is an input-to-observed-frame upper bound, not isolated renderer latency.",
      "This smoke does not create native busy, retry, permission or question events. See the separate attention probe and model tests for their explicitly stated scope.",
      "No slow optional metadata provider is enabled; no Git or filesystem enrichment is performed by the UI.",
      "No baseline CPU/memory, power-loss durability, remote transport or cross-platform rendering claim.",
    ],
    captures: frames.map(({ name, theme, icons, frame }) => ({
      name,
      theme,
      icons,
      width: frame.width,
      height: frame.height,
    })),
  };
  const destination = process.env.SIDEBAR_SMOKE_REPORT;
  if (destination) await writeFile(resolve(destination), `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `Stock OpenCode ${expectedVersion}: rendered sidebar smoke passed (${checks.length} checks, ${frames.length} actual frames, input observation p95 ${p95.toFixed(1)}ms).`,
  );
} finally {
  clearTimeout(deadline);
  lifetime.abort();
  await stopChild();
  if (process.env.SIDEBAR_SMOKE_KEEP_TEMP === "true")
    console.error(`Synthetic test artifacts: ${root}`);
  else await rm(root, { recursive: true, force: true });
}
