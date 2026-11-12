/** Stock TUI attach through a lossy loopback proxy; no injected disconnect signal. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, request as upstreamRequest, type ClientRequest } from "node:http";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import type { Socket } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { startGraphicalTerminal, type GraphicalTerminal } from "./lib/graphical-terminal";

import { validationHostVersion as expectedVersion } from "./lib/validation-host";
assert(
  process.env.OPENCODE_BIN,
  "Set OPENCODE_BIN to the explicitly selected stock OpenCode version.",
);
assert(process.platform !== "win32", "The native attach probe needs a POSIX PTY.");
const executable = await realpath(process.env.OPENCODE_BIN);
const plugin = await realpath(
  process.env.SIDEBAR_PLUGIN_FILE ?? resolve(import.meta.dir, "../dist/tui.js"),
);
const root = await mkdtemp(join(tmpdir(), "sidebar-remote-smoke-"));
const project = join(root, "remote-project");
const localProject = join(root, "client-project");
const storage = join(root, "annotations");
const exchange = join(root, "exchange");
const reportFile = process.env.SIDEBAR_REMOTE_REPORT ?? join(root, "report.json");
const framesFile = process.env.SIDEBAR_REMOTE_FRAMES ?? join(root, "frames.json");
const controller = new AbortController();
const sockets = new Set<Socket>();
const requests = new Set<ClientRequest>();
const checks: { name: string; status: "passed" | "failed"; detail?: string }[] = [];
const frames: { name: string; snapshot: Snapshot }[] = [];
const proxyActivity = { forwarded: 0, rejected: 0, eventStreams: 0, cuts: 0 };
const budgets = {
  totalMs: 240_000,
  // Quiet health: at most 60s to the next probe + 2s deadline, with scheduling margin.
  outageMs: 70_000,
  // A longer cut reaches the native SSE client's 30s maximum reconnect backoff.
  reconnectMs: 35_000,
  liveEventMs: 2_000,
  observerResponseMs: 2_000,
};
let online = true;
let baseUrl = "";
let server: ReturnType<typeof Bun.spawn> | undefined;
let tui: ReturnType<typeof Bun.spawn> | undefined;
let graphical: GraphicalTerminal | undefined;
const graphicalRuns: ReturnType<GraphicalTerminal["metadata"]>[] = [];
let outputTail = "";
let serverOutput = "";
let requestId = 0;
let fatal: string | undefined;
let runtimeVersion: string | undefined;
let reconnectElapsedMs: number | undefined;

type Span = { text: string; width: number; fg: number[]; bg: number[]; attributes: number };
type Geometry = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  text?: string;
};
type Snapshot = {
  elapsedMs: number;
  events: { type: string; elapsedMs: number }[];
  route: { name: string; params?: { sessionID?: string } };
  dialogDepth: number;
  plugins: { id: string; active: boolean }[];
  hostSessions: { id: string; title?: string; status?: { type: string } }[];
  organization: {
    revision: number;
    pins: string[];
    later: string[];
    completionStates: { sessionKey: string; done: boolean }[];
  } | null;
  geometry: Geometry[];
  frame: { width: number; height: number; frameId: number; lines: Span[][] };
};

const proxy = createServer((incoming, outgoing) => {
  if (!online) {
    proxyActivity.rejected++;
    outgoing.writeHead(503, { "content-type": "text/plain", connection: "close" });
    outgoing.end("Synthetic transport outage");
    return;
  }
  proxyActivity.forwarded++;
  if (incoming.url?.split("?")[0]?.endsWith("/event")) proxyActivity.eventStreams++;
  const target = new URL(incoming.url ?? "/", baseUrl);
  const upstream = upstreamRequest(
    target,
    { method: incoming.method, headers: incoming.headers },
    (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
      outgoing.on("close", () => response.destroy());
    },
  );
  requests.add(upstream);
  upstream.once("close", () => requests.delete(upstream));
  upstream.on("error", () => outgoing.destroy());
  incoming.on("error", () => upstream.destroy());
  outgoing.on("close", () => upstream.destroy());
  incoming.pipe(upstream);
});
proxy.on("connection", (socket) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
});
function cut(measured = true) {
  online = false;
  if (measured) proxyActivity.cuts++;
  for (const socket of sockets) socket.destroy();
  for (const request of requests) request.destroy();
}
const deadline = setTimeout(() => {
  controller.abort(new Error("Remote native probe exceeded its total budget."));
  void graphical?.close();
  tui?.kill("SIGKILL");
  server?.kill("SIGKILL");
  cut(false);
}, budgets.totalMs);

function record(name: string, passed: boolean, detail?: string) {
  checks.push({ name, status: passed ? "passed" : "failed", ...(detail ? { detail } : {}) });
}
function text(snapshot: Snapshot) {
  return snapshot.frame.lines.map((line) => line.map((span) => span.text).join("")).join("\n");
}
function node(snapshot: Snapshot, id: string) {
  return snapshot.geometry.find((item) => item.id === id && item.visible && item.height > 0);
}
function status(snapshot: Snapshot, sessionId: string) {
  return node(snapshot, `sidebar-session-${sessionId}-status`)?.text?.trim();
}
function sidebarRowText(snapshot: Snapshot, sessionId: string) {
  const statusNode = node(snapshot, `sidebar-session-${sessionId}-status`);
  if (!statusNode || statusNode.y < 0 || statusNode.y >= snapshot.frame.height) return "";
  // The native header may keep a cached title independently of sidebar reconciliation.
  // Inspect this session's actual sidebar row, not any matching text in the terminal.
  return snapshot.frame.lines[statusNode.y]!.map((span) => span.text)
    .join("")
    .slice(statusNode.x);
}
async function pause(ms = 25) {
  controller.signal.throwIfAborted();
  await Bun.sleep(ms);
}
async function request<T>(type: string, fields: object = {}): Promise<T> {
  const id = ++requestId;
  await writeFile(`${exchange}.request.tmp`, JSON.stringify({ id, type, ...fields }));
  await rename(`${exchange}.request.tmp`, `${exchange}.request.json`);
  const started = performance.now();
  for (;;) {
    assert(tui?.exitCode === null, `Attached TUI exited unexpectedly: ${outputTail}`);
    const raw = await readFile(`${exchange}.response.json`, "utf8").catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (raw) {
      const response = JSON.parse(raw) as { id: number; ok: boolean; error?: string; result: T };
      if (response.id === id) {
        assert(response.ok, response.error ?? "The local observer rejected the request.");
        return response.result;
      }
    }
    assert(
      performance.now() - started < budgets.observerResponseMs,
      `Local observer did not answer ${type} while transport was ${online ? "online" : "offline"}.`,
    );
    await pause(10);
  }
}
async function until(check: (snapshot: Snapshot) => boolean, description: string, budget = 5_000) {
  const started = performance.now();
  let last: Snapshot | undefined;
  do {
    last = await request<Snapshot>("snapshot");
    if (check(last)) return last;
    await pause();
  } while (performance.now() - started < budget);
  throw new Error(`${description}\n${last ? text(last) : outputTail}`);
}
function input(value: string) {
  if (graphical) return graphical.input(value);
  assert(tui?.terminal);
  tui.terminal.write(value);
}
async function capture(name: string) {
  const snapshot = await request<Snapshot>("snapshot");
  frames.push({ name, snapshot });
  if (graphical) await graphical.capture(name);
  await writeFile(framesFile, JSON.stringify(frames).replaceAll(root, "/synthetic"));
  return snapshot;
}
async function choose(title: string, action: string) {
  await request("command", { command: "sessions-sidebar.browse" });
  await until((snapshot) => snapshot.dialogDepth > 0, "Browse did not open.");
  input(title);
  await until((snapshot) => text(snapshot).includes(title), "Browse filter did not render.");
  input("\r");
  await until((snapshot) => text(snapshot).includes("Open session"), "Session menu did not open.");
  input(action);
  await until((snapshot) => text(snapshot).includes(action), "Action filter did not render.");
  input("\r");
  await until((snapshot) => snapshot.dialogDepth === 0, "Action did not close its dialog.");
}
async function stopTui() {
  if (!tui) return;
  if (graphical) {
    graphicalRuns.push(graphical.metadata());
    await graphical.close();
    graphical = undefined;
    tui = undefined;
    return;
  }
  tui.kill("SIGKILL");
  await tui.exited;
  tui.terminal?.close();
  tui = undefined;
}
function environment(profile: string) {
  return {
    PATH: process.env.PATH ?? "",
    OPENCODE_TEST_HOME: join(root, profile, "home"),
    OPENCODE_TEST_MANAGED_CONFIG_DIR: join(root, "managed"),
    XDG_CONFIG_HOME: join(root, profile, "config"),
    XDG_DATA_HOME: join(root, profile, "data"),
    XDG_CACHE_HOME: join(root, profile, "cache"),
    XDG_STATE_HOME: join(root, profile, "state"),
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
    TERM: "xterm-256color",
    LANG: "C.UTF-8",
  };
}
async function drain(stream: ReadableStream<Uint8Array>, receive: (text: string) => void) {
  for await (const chunk of stream) receive(new TextDecoder().decode(chunk));
}

try {
  if (process.platform === "darwin") {
    for (const path of [
      "/Library/Managed Preferences/ai.opencode.managed.plist",
      join("/Library/Managed Preferences", userInfo().username, "ai.opencode.managed.plist"),
    ]) {
      const exists = await lstat(path).then(
        () => true,
        (error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        },
      );
      assert(!exists, "Use an unmanaged isolated test host.");
    }
  }
  await Promise.all(
    [
      project,
      localProject,
      join(root, "managed"),
      ...["server", "client"].flatMap((profile) => [
        join(root, profile, "home"),
        join(root, profile, "config", "opencode"),
      ]),
    ].map((path) => mkdir(path, { recursive: true })),
  );
  for (const profile of ["server", "client"])
    await writeFile(join(root, profile, "config", "opencode", "opencode.json"), "{}");
  const version = Bun.spawn([executable, "--version"], {
    env: environment("server"),
    stdout: "pipe",
    stderr: "pipe",
    signal: controller.signal,
  });
  runtimeVersion = (await new Response(version.stdout).text()).trim();
  assert.equal(runtimeVersion, expectedVersion);
  assert.equal(await version.exited, 0);
  const observer = join(root, "remote-observer.mjs");
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "sidebar-remote-probe.ts")],
    target: "bun",
    format: "esm",
  });
  assert(built.success && built.outputs[0], "Could not build offline-safe observer.");
  await Bun.write(observer, built.outputs[0]);
  await writeFile(
    join(root, "client", "config", "opencode", "tui.json"),
    JSON.stringify({
      plugin: [
        [
          pathToFileURL(plugin).href,
          {
            hostId: "synthetic-sidebar-remote",
            storageDirectory: storage,
            icons: "ascii",
            reducedMotion: true,
          },
        ],
        pathToFileURL(observer).href,
      ],
    }),
  );

  // Stock --port 0 may choose its usual default; select an unused loopback port explicitly.
  const reservation = createServer();
  await new Promise<void>((resolveListen, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolveListen);
  });
  const reserved = reservation.address();
  assert(reserved && typeof reserved !== "string");
  const serverPort = String(reserved.port);
  await new Promise<void>((resolveClose) => reservation.close(() => resolveClose()));
  server = Bun.spawn(
    [executable, "serve", "--pure", "--hostname", "127.0.0.1", "--port", serverPort],
    {
      cwd: project,
      env: environment("server"),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  assert(
    server.stdout &&
      typeof server.stdout !== "number" &&
      server.stderr &&
      typeof server.stderr !== "number",
  );
  void drain(server.stdout, (output) => {
    serverOutput = (serverOutput + output).slice(-12_000);
    baseUrl ||= serverOutput.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0] ?? "";
  });
  void drain(server.stderr, (output) => {
    serverOutput = (serverOutput + output).slice(-12_000);
  });
  const serverStarted = performance.now();
  while (!baseUrl) {
    assert(
      server.exitCode === null && performance.now() - serverStarted < 35_000,
      `Server startup failed: ${serverOutput}`,
    );
    await pause();
  }
  const client = createOpencodeClient({ baseUrl });
  const sdkOptions = { signal: controller.signal, throwOnError: true as const };
  const currentProject = await client.project.current({ directory: project }, sdkOptions);
  assert(currentProject.data);
  const alpha = await client.session.create(
    { directory: project, title: "Remote Alpha" },
    sdkOptions,
  );
  const beta = await client.session.create(
    { directory: project, title: "Remote Beta" },
    sdkOptions,
  );
  assert(alpha.data && beta.data);
  const alphaId = alpha.data.id;
  const betaId = beta.data.id;
  await new Promise<void>((resolveListen, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", resolveListen);
  });
  const address = proxy.address();
  assert(address && typeof address !== "string");
  const proxyUrl = `http://127.0.0.1:${address.port}`;
  async function launch() {
    await rm(`${exchange}.ready.json`, { force: true });
    await rm(`${exchange}.request.json`, { force: true });
    outputTail = "";
    const launchEnv = {
      ...environment("client"),
      SIDEBAR_TEST_OPENCODE_VERSION: expectedVersion,
      SIDEBAR_REMOTE_EXCHANGE: exchange,
      SIDEBAR_REMOTE_STORAGE: storage,
      SIDEBAR_REMOTE_PROJECT: currentProject.data!.id,
      SIDEBAR_REMOTE_SESSIONS: JSON.stringify([alphaId, betaId]),
    };
    if (process.env.SIDEBAR_GRAPHICAL_DIR) {
      graphical = await startGraphicalTerminal({
        executable,
        args: ["attach", proxyUrl, "--dir", project, "--session", alphaId],
        cwd: localProject,
        env: launchEnv,
        cols: 140,
        rows: 40,
        theme: "dark",
        directory: join(process.env.SIDEBAR_GRAPHICAL_DIR, "remote"),
        label: `remote-${graphicalRuns.length}`,
      });
      tui = graphical.process;
    } else
      tui = Bun.spawn([executable, "attach", proxyUrl, "--dir", project, "--session", alphaId], {
        cwd: localProject,
        env: {
          ...environment("client"),
          SIDEBAR_TEST_OPENCODE_VERSION: expectedVersion,
          SIDEBAR_REMOTE_EXCHANGE: exchange,
          SIDEBAR_REMOTE_STORAGE: storage,
          SIDEBAR_REMOTE_PROJECT: currentProject.data!.id,
          SIDEBAR_REMOTE_SESSIONS: JSON.stringify([alphaId, betaId]),
        },
        terminal: {
          cols: 140,
          rows: 40,
          data(terminal, bytes) {
            const output = new TextDecoder().decode(bytes);
            outputTail = (outputTail + output).slice(-16_000);
            if (output.includes("\u001b]10;?"))
              terminal.write("\u001b]10;rgb:ffff/ffff/ffff\u001b\\");
            if (output.includes("\u001b]11;?"))
              terminal.write("\u001b]11;rgb:0000/0000/0000\u001b\\");
            if (output.includes("\u001b[6n")) terminal.write("\u001b[1;1R");
          },
        },
      });
    const began = performance.now();
    while (!(await Bun.file(`${exchange}.ready.json`).exists())) {
      assert(
        tui.exitCode === null && performance.now() - began < 35_000,
        `Attached TUI observer failed: ${outputTail}`,
      );
      await pause();
    }
    await until(
      (snapshot) =>
        snapshot.plugins.some((item) => item.id === "opencode-sessions-sidebar" && item.active) &&
        Boolean(node(snapshot, `sidebar-session-${alphaId}-status`)),
      "Sidebar did not activate against the separate server.",
      15_000,
    );
    const initial = await request<Snapshot>("snapshot");
    if (text(initial).includes("Getting started")) {
      const lines = initial.frame.lines.map((line) => line.map((span) => span.text).join(""));
      const row = lines.findIndex((line) => line.includes("Getting started"));
      const column = lines[row]?.indexOf("✕") ?? -1;
      assert(column >= 0, "Native onboarding close button was not visible.");
      input(`\u001b[<0;${column + 1};${row + 1}M\u001b[<0;${column + 1};${row + 1}m`);
      await until(
        (snapshot) => !text(snapshot).includes("Getting started"),
        "Native onboarding did not close.",
      );
    }
    await until(
      (snapshot) => snapshot.route.params?.sessionID === alphaId,
      "Native onboarding dismissal changed the attached session selection.",
    );
  }
  await launch();
  await until(
    (snapshot) => status(snapshot, alphaId) === ".",
    "Baseline session must be confirmed idle before testing transport uncertainty.",
  );
  record("stock attach loads the sidebar against a separate server and local client profile", true);
  await choose("Remote Alpha", "Mark completed");
  await choose("Remote Alpha", "Pin");
  await choose("Remote Alpha", "Add to Later");
  const organized = await until(
    (snapshot) =>
      Boolean(
        snapshot.organization?.completionStates.some((item) => item.done) &&
          snapshot.organization.pins.length === 1 &&
          snapshot.organization.later.length === 1,
      ),
    "Annotations were not committed through real TUI keyboard actions.",
  );
  const beforeOrganization = organized.organization!;
  assert.equal(
    organized.route.params?.sessionID,
    alphaId,
    "Mark, pin and Later must preserve the selected attached session.",
  );
  record("mark, pin and Later persist through real attached TUI actions", true);
  await capture("remote-before-cut");

  const outageStarted = performance.now();
  cut();
  await pause(250);
  const afterCut = await capture("remote-cut-start");
  await client.session.update(
    { directory: project, sessionID: alphaId, title: "Remote Alpha changed offline" },
    sdkOptions,
  );
  await client.session.delete({ directory: project, sessionID: betaId }, sdkOptions);
  const gamma = await client.session.create(
    { directory: project, title: "Remote Gamma created offline" },
    sdkOptions,
  );
  assert(gamma.data);
  while (performance.now() - outageStarted < budgets.outageMs) await pause(100);
  const disconnected = await capture("remote-during-cut");
  const outageGlyph = status(disconnected, alphaId);
  record("local observer remains responsive throughout the real transport cut", true);
  record(
    "native sidebar marks activity uncertain while disconnected",
    outageGlyph === "?",
    `After ${Math.round(performance.now() - outageStarted)} ms without transport, the rendered activity glyph was ${JSON.stringify(outageGlyph)}; expected '?'. No invalidation or refresh was injected.`,
  );
  record(
    "offline server changes do not leak through the severed client transport",
    sidebarRowText(disconnected, alphaId).includes("Remote Alpha") &&
      !sidebarRowText(disconnected, alphaId).includes("changed offline") &&
      !node(disconnected, `sidebar-session-${gamma.data.id}-status`),
  );
  record(
    "annotations are preserved during loss of transport",
    JSON.stringify(disconnected.organization) === JSON.stringify(beforeOrganization),
  );

  online = true;
  const restored = performance.now();
  let recovered: Snapshot | undefined;
  function reconciled(snapshot: Snapshot) {
    return (
      sidebarRowText(snapshot, alphaId).includes("Remote Alpha changed offline") &&
      sidebarRowText(snapshot, gamma.data!.id).includes("Remote Gamma created offline") &&
      !node(snapshot, `sidebar-session-${betaId}-status`)
    );
  }
  try {
    recovered = await until(
      (snapshot) => reconciled(snapshot) && proxyActivity.eventStreams >= 2,
      "Automatic recovery did not reconcile sessions and reopen the native event stream.",
      budgets.reconnectMs,
    );
    reconnectElapsedMs = performance.now() - restored;
    record(
      "native reconnect reconciles missed rename/create/delete without a manual refresh",
      true,
    );
  } catch (error) {
    record(
      "native reconnect reconciles missed rename/create/delete without a manual refresh",
      false,
      String(error),
    );
  }
  const afterRestore = await capture("remote-after-restore");
  record(
    "annotations survive native transport restoration",
    JSON.stringify(afterRestore.organization) === JSON.stringify(beforeOrganization),
  );
  record(
    "the native event stream reopens after restoring transport",
    proxyActivity.eventStreams >= 2,
    `Observed ${proxyActivity.eventStreams} forwarded event subscriptions.`,
  );
  if (recovered) {
    await client.session.update(
      { directory: project, sessionID: gamma.data.id, title: "Remote Gamma live after restore" },
      sdkOptions,
    );
    await until(
      (snapshot) =>
        sidebarRowText(snapshot, gamma.data!.id).includes("Remote Gamma live after restore"),
      "Restored native events did not deliver a new update without a refresh.",
      budgets.liveEventMs,
    );
    record("restored native events deliver new changes without a refresh", true);
  }
  if (!recovered) {
    await request("command", { command: "sessions-sidebar.refresh" });
    await until(reconciled, "Explicit recovery refresh also failed.", 10_000);
    record("explicit refresh recovers after the failed automatic reconnect", true);
    await capture("remote-after-explicit-refresh");
  }
  await stopTui();
  await launch();
  const restarted = await until(
    (snapshot) =>
      Boolean(
        snapshot.organization?.completionStates.some((item) => item.done) &&
          snapshot.organization.pins.length === 1 &&
          snapshot.organization.later.length === 1 &&
          sidebarRowText(snapshot, alphaId).includes("Remote Alpha changed offline"),
      ),
    "Annotations or remote state were lost after restarting only the client.",
  );
  record(
    "client restart preserves mark/pin/Later and loads current server state",
    JSON.stringify(restarted.organization) === JSON.stringify(beforeOrganization),
  );
  await capture("remote-client-restarted");
  // Keep explicit snapshots available even when the disconnect acceptance gate fails.
  assert(afterCut.frame.width > 0);
} catch (error) {
  fatal = error instanceof Error ? error.message : String(error);
  record("remote campaign completed", false, fatal);
  if (tui?.exitCode === null) await capture("remote-failure").catch(() => undefined);
} finally {
  clearTimeout(deadline);
  controller.abort();
  await stopTui();
  cut(false);
  if (proxy.listening) await new Promise<void>((resolveClose) => proxy.close(() => resolveClose()));
  if (server) {
    server.kill("SIGKILL");
    await server.exited;
  }
  const artifactHashes = Object.fromEntries(
    await Promise.all(
      [
        "src/tui.tsx",
        "src/ui/controller.ts",
        "src/ui/model.ts",
        "src/ui/view.tsx",
        "src/ui/end-label.tsx",
        "src/ui/viewport.ts",
        "src/adapters/opencode-v1/adapter.ts",
        "src/adapters/opencode-v1/transport-health.ts",
        "src/adapters/opencode-v1/transport-health.ts",
        "scripts/sidebar-remote-probe.ts",
        "scripts/smoke-sidebar-remote.ts",
        "scripts/lib/validation-host.ts",
        "scripts/lib/graphical-terminal.ts",
      ].map(async (file) => [
        file,
        createHash("sha256")
          .update(await readFile(resolve(import.meta.dir, "..", file)))
          .digest("hex"),
      ]),
    ),
  );
  artifactHashes.runtimePlugin = createHash("sha256")
    .update(await readFile(plugin))
    .digest("hex");
  const report = {
    status: checks.some((check) => check.status === "failed") ? "failed" : "passed",
    version: runtimeVersion,
    bunVersion: Bun.version,
    platform: process.platform,
    budgets,
    checks,
    proxyActivity,
    graphicalRuns,
    reconnectElapsedMs,
    artifactHashes,
    evidence:
      "Real stock TUI attach, separate loopback server, socket-destroying proxy, local-only observation, public CRUD and actual keyboard organization actions.",
    limitations: [
      "Controlled loopback transport, not SSH or arbitrary WAN behavior.",
      "No injected adapter invalidation or transport event.",
      "Automatic completion policies and correlated report exceptions are outside this transport probe.",
      graphicalRuns.length
        ? "PNG captures are actual xterm window pixels; renderer buffers are additional structured evidence."
        : "Captured renderer buffers are not terminal-pixel screenshots.",
    ],
    ...(fatal ? { fatal, outputTail, serverOutput } : {}),
  };
  await writeFile(
    reportFile,
    JSON.stringify(report, null, 2).replaceAll(root, "/synthetic") + "\n",
  );
  console.log(
    `Native remote attach: ${report.status}; ${checks.filter((check) => check.status === "passed").length}/${checks.length} checks. Report: ${reportFile}`,
  );
  if (report.status === "failed") process.exitCode = 1;
  if (
    process.env.SIDEBAR_SMOKE_KEEP !== "true" &&
    process.env.SIDEBAR_REMOTE_REPORT &&
    process.env.SIDEBAR_REMOTE_FRAMES
  )
    await rm(root, { recursive: true, force: true });
}
