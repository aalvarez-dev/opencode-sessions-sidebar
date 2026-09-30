/** Real stock-server smoke test. The TUI event/route port is a test bridge, not a loaded TUI. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createOpencodeClient, type Event } from "@opencode-ai/sdk/v2";
import { createV1Adapter } from "../src/adapters/opencode-v1/index.js";
import type { V1HostPort } from "../src/adapters/opencode-v1/types.js";

const expectedVersion = "1.18.30";
const binary = process.env.OPENCODE_BIN;
assert(binary, "Set OPENCODE_BIN to an installed stock OpenCode 1.18.30 binary.");
const executable = await realpath(binary);
const testTui = process.argv.includes("--tui");
assert(!testTui || process.platform !== "win32", "The optional TUI probe requires a POSIX PTY.");
const root = await mkdtemp(join(tmpdir(), "sidebar-v1-smoke-"));
const project = join(root, "project");
const otherProject = join(root, "other-project");
const config = join(root, "config");
const lifecycle = new AbortController();
const streams = new Set<AbortController>();
const cleanups = new Set<() => void | Promise<void>>();
let server: ReturnType<typeof Bun.spawn> | undefined;
let adapter: ReturnType<typeof createV1Adapter> | undefined;
const timeout = setTimeout(() => {
  lifecycle.abort(new Error("Runtime smoke test exceeded 75 seconds."));
  for (const stream of streams) stream.abort();
  server?.kill("SIGKILL");
}, 75_000);

async function until(check: () => boolean, message: string, budget = 10_000) {
  const start = performance.now();
  while (!check()) {
    lifecycle.signal.throwIfAborted();
    assert(performance.now() - start < budget, message);
    await Bun.sleep(20);
  }
}

try {
  await Promise.all([
    mkdir(project),
    mkdir(otherProject),
    mkdir(join(config, "opencode"), { recursive: true }),
  ]);
  await writeFile(join(config, "opencode", "opencode.json"), "{}");
  // Allowlist the child environment: no inherited provider credentials or user configuration.
  const env = {
    PATH: process.env.PATH ?? "",
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
    OPENCODE_DISABLE_MODELS_FETCH: "true",
  };
  const version = Bun.spawn([executable, "--version"], {
    cwd: project,
    env,
    stdout: "pipe",
    stderr: "pipe",
    signal: lifecycle.signal,
  });
  assert.equal((await new Response(version.stdout).text()).trim(), expectedVersion);
  assert.equal(await version.exited, 0);
  server = Bun.spawn([executable, "serve", "--pure", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: project,
    env,
    stdout: "pipe",
    stderr: "ignore",
  });
  let baseUrl: string | undefined;
  const stdout = server.stdout;
  assert(stdout && typeof stdout !== "number");
  const drain = (async () => {
    let output = "";
    for await (const chunk of stdout) {
      output = (output + new TextDecoder().decode(chunk)).slice(-4096);
      baseUrl ??= output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    }
  })();
  await until(() => Boolean(baseUrl), "Stock server did not start.", 45_000);
  assert(baseUrl);
  const client = createOpencodeClient({ baseUrl });
  const projectResult = await client.project.current(
    { directory: project },
    { signal: lifecycle.signal, throwOnError: true },
  );
  assert(projectResult.data);

  const listeners = new Map<Event["type"], Set<(event: Event) => void>>();
  let current: V1HostPort["route"]["current"] = { name: "home" };
  const host: V1HostPort = {
    get client() {
      return client;
    },
    event: {
      on(type, handler) {
        const subscribed = listeners.get(type) ?? new Set();
        const receive = handler as (event: Event) => void;
        subscribed.add(receive);
        listeners.set(type, subscribed);
        return () => {
          subscribed.delete(receive);
        };
      },
    },
    lifecycle: {
      signal: lifecycle.signal,
      onDispose(cleanup) {
        cleanups.add(cleanup);
        return () => {
          cleanups.delete(cleanup);
        };
      },
    },
    route: {
      get current() {
        return current;
      },
      navigate(name, params) {
        current = params ? { name, params } : { name };
      },
    },
  };
  const observed: Event[] = [];
  let connected = 0;
  function connect() {
    const controller = new AbortController();
    streams.add(controller);
    let streamError: unknown;
    const run = (async () => {
      const subscription = await client.event.subscribe(
        { directory: project },
        { signal: controller.signal, sseMaxRetryAttempts: 0 },
      );
      for await (const event of subscription.stream) {
        if (controller.signal.aborted) break;
        observed.push(event);
        if (event.type === "server.connected") connected++;
        for (const listener of listeners.get(event.type) ?? []) listener(event);
      }
    })().catch((error: unknown) => {
      if (!controller.signal.aborted) streamError = error;
    });
    return {
      async stop() {
        controller.abort();
        await run;
        streams.delete(controller);
        if (streamError) throw streamError;
      },
    };
  }
  let stream = connect();
  await until(() => connected === 1, "Missing real server.connected event.");
  adapter = createV1Adapter(host, {
    hostId: "synthetic-runtime",
    projectId: projectResult.data.id,
    directory: project,
  });
  await adapter.start();
  assert.equal(adapter.state().phase, "ready");
  assert.equal(adapter.state().executionCorrelation, "unavailable");
  assert.equal(adapter.list().length, 0);
  const initialStatus = await client.session.status({ directory: project });
  assert.deepEqual(initialStatus.data, {});
  assert.deepEqual((await client.permission.list({ directory: project })).data, []);
  assert.deepEqual((await client.question.list({ directory: project })).data, []);

  const created = await adapter.create("Synthetic adapter session");
  assert.equal(created.status, "succeeded");
  assert(created.sessionId);
  const sessionId = created.sessionId;
  await until(() => Boolean(adapter?.get(sessionId)), "Created session missing.");
  await adapter.refresh();
  assert.equal(adapter.get(sessionId)?.activity, "idle");
  assert.equal((await adapter.rename(sessionId, "Synthetic renamed")).status, "succeeded");
  await until(() => adapter?.get(sessionId)?.title === "Synthetic renamed", "Rename missing.");

  const child = await client.session.create(
    { directory: project, parentID: sessionId, title: "Synthetic child" },
    { signal: lifecycle.signal, throwOnError: true },
  );
  assert(child.data);
  const childId = child.data.id;
  await until(() => Boolean(adapter?.get(childId)), "Native child event missing.");
  assert.equal(adapter.get(childId)?.parentId, sessionId);
  const foreign = await client.session.create(
    { directory: otherProject, title: "Synthetic other directory" },
    { signal: lifecycle.signal, throwOnError: true },
  );
  assert(foreign.data);
  await adapter.refresh();
  assert.equal(adapter.get(foreign.data.id), undefined);
  assert.equal(adapter.list().length, 2);

  const open = await adapter.open(sessionId);
  assert.equal(open.status, "requested");
  adapter.observeRoute();
  assert.equal(adapter.state().selectedSessionId, sessionId);
  await stream.stop();
  stream = connect();
  await until(() => connected === 2, "Reconnect did not emit server.connected.");
  await until(() => adapter?.state().phase === "ready", "Reconnect did not reconcile.");
  assert.equal(adapter.state().executionCorrelation, "unavailable");
  assert.equal((await adapter.delete(sessionId)).status, "succeeded");
  await until(
    () => !adapter?.get(sessionId) && !adapter?.get(childId),
    "Deleting parent did not remove its child.",
  );
  for (const type of [
    "server.connected",
    "session.created",
    "session.updated",
    "session.deleted",
  ]) {
    const events = observed.filter((event) => event.type === type);
    assert(events.length > 0, `Missing real ${type} event.`);
    assert(events.every((event) => typeof event.id === "string" && event.id.startsWith("evt_")));
  }
  adapter.dispose();
  assert.equal(adapter.state().phase, "disposed");
  assert([...listeners.values()].every((set) => set.size === 0));
  await stream.stop();
  server.kill("SIGKILL");
  await drain.catch(() => {});
  await server.exited;
  if (testTui) {
    const plugin = join(root, "probe.mjs");
    const probeOutput = join(root, "probe-result.json");
    const build = await Bun.build({
      entrypoints: [join(import.meta.dir, "v1-probe.ts")],
      target: "bun",
      format: "esm",
    });
    assert(build.success && build.outputs[0], "Could not build the temporary TUI probe.");
    await Bun.write(plugin, build.outputs[0]);
    await writeFile(
      join(config, "opencode", "tui.json"),
      JSON.stringify({ plugin: [pathToFileURL(plugin).href] }),
    );
    server = Bun.spawn([executable], {
      cwd: project,
      env: {
        ...env,
        TERM: "xterm-256color",
        LANG: "C.UTF-8",
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
        SIDEBAR_PROBE_OUTPUT: probeOutput,
        SIDEBAR_PROBE_DIRECTORY: project,
      },
      terminal: {
        cols: 140,
        rows: 40,
        data(terminal, data) {
          const output = new TextDecoder().decode(data);
          // Reply to ordinary terminal capability probes, without submitting user input.
          if (output.includes("\u001b]11;?"))
            terminal.write("\u001b]11;rgb:0000/0000/0000\u001b\\");
          if (output.includes("\u001b[6n")) terminal.write("\u001b[1;1R");
        },
      },
    });
    const started = performance.now();
    // A BunFile can cache its initial missing-file metadata; stat a fresh handle each time.
    while (!(await Bun.file(probeOutput).exists())) {
      lifecycle.signal.throwIfAborted();
      assert(server.exitCode === null, "Stock TUI exited before loading the probe.");
      assert(performance.now() - started < 45_000, "Stock TUI probe timed out.");
      await Bun.sleep(20);
    }
    const result: { passed: boolean; version?: string; message?: string } =
      await Bun.file(probeOutput).json();
    assert(result.passed, result.message ?? "Stock TUI probe failed.");
    assert.equal(result.version, expectedVersion);
    console.log(
      "Stock TUI probe passed: plugin loading, host events, CRUD, real route selection and disposal.",
    );
  }
  console.log(
    `Stock OpenCode ${expectedVersion}: SDK/SSE adapter smoke passed (CRUD, children, directory scope, sparse idle, reconnect, cleanup).`,
  );
  console.log(
    "No model inference. Live busy/attention, rendering and performance are separate gates.",
  );
} finally {
  clearTimeout(timeout);
  lifecycle.abort();
  for (const stream of streams) stream.abort();
  adapter?.dispose();
  for (const cleanup of cleanups) await cleanup();
  if (server) {
    server.kill("SIGKILL");
    await server.exited;
    server.terminal?.close();
  }
  await rm(root, { recursive: true, force: true });
}
