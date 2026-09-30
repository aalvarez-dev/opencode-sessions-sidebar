/** Common instrumentation for the stock-TUI baseline; it does not render a sidebar. */
import assert from "node:assert/strict";
import { readFile, rename, writeFile } from "node:fs/promises";
import type { TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import type { V1HostPort } from "../src/adapters/opencode-v1/types.js";

type AdapterModule = typeof import("../src/adapters/opencode-v1/index.js");

async function publish(path: string, value: object) {
  await writeFile(`${path}.tmp`, JSON.stringify(value));
  await rename(`${path}.tmp`, path);
}

async function measure(api: TuiPluginApi) {
  const output = process.env.SIDEBAR_BENCHMARK_OUTPUT;
  const directory = process.env.SIDEBAR_BENCHMARK_DIRECTORY;
  const moduleUrl = process.env.SIDEBAR_BENCHMARK_MODULE;
  const enabled = process.env.SIDEBAR_BENCHMARK_ENABLED === "true";
  const expectedSessions = Number(process.env.SIDEBAR_BENCHMARK_SESSIONS);
  assert(output && directory && moduleUrl);
  let adapter: ReturnType<AdapterModule["createV1Adapter"]> | undefined;
  const counters = { reads: 0, pending: 0, eventHandlers: 0, disposeHooks: 0 };
  try {
    assert.equal(api.app.version, "1.18.30");
    const project = await api.client.project.current({ directory }, { throwOnError: true });
    assert(project.data);
    const scope = { hostId: "synthetic-tui-benchmark", projectId: project.data.id, directory };
    const measuredClient = <T extends object>(client: T): T =>
      new Proxy(client, {
        get(target, property, receiver) {
          const method: unknown = Reflect.get(target, property, receiver);
          if (typeof method !== "function") return method;
          return async (...args: unknown[]) => {
            counters.reads++;
            counters.pending++;
            try {
              return await Reflect.apply(method, target, args);
            } finally {
              counters.pending--;
            }
          };
        },
      });
    const port: V1HostPort = {
      get client() {
        const client = api.client;
        return {
          session: measuredClient(client.session),
          permission: measuredClient(client.permission),
          question: measuredClient(client.question),
        };
      },
      event: {
        on(type, handler) {
          const dispose = api.event.on(type, handler);
          counters.eventHandlers++;
          let active = true;
          return () => {
            if (!active) return;
            active = false;
            dispose();
            counters.eventHandlers--;
          };
        },
      },
      lifecycle: {
        signal: api.lifecycle.signal,
        onDispose(handler) {
          const dispose = api.lifecycle.onDispose(handler);
          counters.disposeHooks++;
          let active = true;
          return () => {
            if (!active) return;
            active = false;
            dispose();
            counters.disposeHooks--;
          };
        },
      },
      route: api.route,
    };
    let adapterModule: AdapterModule | undefined;
    const activationMs: number[] = [];
    const cycleCounters: (typeof counters)[] = [];
    const activate = async () => {
      const started = performance.now();
      // Only the enabled treatment imports/evaluates adapter code. The baseline has no static import.
      adapterModule ??= (await import(moduleUrl)) as AdapterModule;
      adapter = adapterModule.createV1Adapter(port, scope);
      await adapter.start();
      activationMs.push(performance.now() - started);
      assert.equal(adapter.state().phase, "ready");
      assert.equal(adapter.state().partial, false);
      assert.equal(adapter.list().length, expectedSessions);
    };
    const dispose = () => {
      adapter?.dispose();
      assert.equal(adapter?.state().phase, "disposed");
      assert.equal(counters.pending, 0);
      assert.equal(counters.eventHandlers, 0);
      assert.equal(counters.disposeHooks, 0);
      cycleCounters.push({ ...counters });
    };
    if (enabled) await activate();
    const idleStart = { ...counters };
    const procStatus = await readFile("/proc/self/status", "utf8");
    const procPid = Number(procStatus.match(/^Pid:\s+(\d+)/m)?.[1]);
    assert(Number.isSafeInteger(procPid) && procPid > 0);
    await publish(`${output}.ready`, {
      enabled,
      version: api.app.version,
      counters: idleStart,
      pid: process.pid,
      procPid,
    });
    // One shared timer, no polling inside the measured process. Parent samples seconds 2–7.
    await Bun.sleep(11_000);
    const idleEnd = { ...counters };
    assert.equal(idleEnd.reads, idleStart.reads, "Adapter initiated reads during idle.");
    if (enabled) {
      dispose();
      for (let cycle = 0; cycle < 2; cycle++) {
        await activate();
        dispose();
      }
      assert.equal(counters.reads, 12, "Expected exactly four snapshot reads per activation.");
    }
    await publish(output, {
      passed: true,
      enabled,
      version: api.app.version,
      activationMs,
      idleStart,
      idleEnd,
      cycleCounters,
      finalCounters: { ...counters },
    });
  } catch (error) {
    await publish(output, { passed: false, message: String(error) });
  } finally {
    adapter?.dispose();
  }
}

export default {
  id: "synthetic-sidebar-benchmark-probe",
  async tui(api) {
    // Returning immediately allows the stock TUI to finish mounting before idle sampling.
    void measure(api);
  },
} satisfies TuiPluginModule;
