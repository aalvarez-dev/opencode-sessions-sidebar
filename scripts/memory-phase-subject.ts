/** Diagnostic wrapper; never an installable product or acceptance substitute. */
import { readFile } from "node:fs/promises";
import { heapStats } from "bun:jsc";
const key = "__sidebarMemoryPhases";
const root = globalThis as any;
const state = (root[key] ??= {
  snapshots: [],
  calls: [],
  liveListeners: 0,
  pending: 0,
  delivered: 0,
  activation: 0,
  suppressedSlots: 0,
});
export async function snapshot(phase: string, api?: any) {
  const start = performance.now();
  const [status, smaps] = await Promise.all([
    readFile("/proc/self/status", "utf8"),
    readFile("/proc/self/smaps_rollup", "utf8"),
  ]);
  const fields = (s: string) =>
    Object.fromEntries(
      [...s.matchAll(/^(\w+):\s+(\d+) kB$/gm)].map((m) => [m[1], Number(m[2]) / 1024]),
    );
  const heap = heapStats();
  const item = {
    phase,
    elapsedMs: start,
    hostBunVersion: Bun.version,
    memory: process.memoryUsage(),
    statusMiB: fields(status),
    smapsMiB: fields(smaps),
    heap,
    liveListeners: state.liveListeners,
    pending: state.pending,
    delivered: state.delivered,
    callCount: state.calls.length,
    suppressedSlots: state.suppressedSlots,
    frame: api?.renderer.frameId,
  };
  state.snapshots.push(item);
  // Native allocator dump belongs only to this instrumented experiment, not resource gates.
  process.stderr.write(`\nMEMORY_PHASE ${phase}\n`);
  const dump = (Bun as any).unsafe?.mimallocDump;
  if (typeof dump === "function") dump();
  else process.stderr.write("MIMALLOC_UNAVAILABLE\n");
  return item;
}
function forward(read: () => any, overrides: Record<string, unknown>) {
  return new Proxy(Object.create(null), {
    get(_t, k) {
      if (Object.hasOwn(overrides, k)) return overrides[k as string];
      const v = read(),
        member = Reflect.get(v, k, v);
      return typeof member === "function" ? member.bind(v) : member;
    },
  });
}
export default {
  id: "synthetic-memory-subject",
  async tui(api: any, options: any) {
    state.activation++;
    const mode = process.env.SIDEBAR_MEMORY_MODE;
    await snapshot(`before-import-${state.activation}`, api);
    const product =
      mode === "control" ? undefined : (await import(process.env.SIDEBAR_MEMORY_PRODUCT!)).default;
    await snapshot(`after-import-${state.activation}`, api);
    if (mode === "control" || mode === "import") return;
    const clientOverrides: Record<string, unknown> = {};
    for (const group of ["project", "session", "permission", "question", "global"]) {
      clientOverrides[group] = new Proxy(Object.create(null), {
        get(_t, method) {
          const target = api.client[group];
          if (typeof target[method] !== "function") return target[method];
          return async (...args: any[]) => {
            const started = performance.now();
            state.pending++;
            try {
              return await Reflect.apply(api.client[group][method], api.client[group], args);
            } finally {
              state.pending--;
              if (state.calls.length < 64)
                state.calls.push({
                  method: `${group}.${String(method)}`,
                  started,
                  durationMs: performance.now() - started,
                });
            }
          };
        },
      });
    }
    const event = forward(() => api.event, {
      on(type: any, fn: any) {
        state.liveListeners++;
        const dispose = api.event.on(type, (...args: any[]) => {
          state.delivered++;
          fn(...args);
        });
        let active = true;
        return () => {
          if (!active) return;
          active = false;
          state.liveListeners--;
          dispose();
        };
      },
    });
    const overrides: any = { client: forward(() => api.client, clientOverrides), event };
    if (mode === "data")
      overrides.slots = forward(() => api.slots, {
        register() {
          state.suppressedSlots++;
          return "synthetic-suppressed-slot";
        },
      });
    await product.tui(
      forward(() => api, overrides),
      options,
    );
    await snapshot(`after-activate-${state.activation}`, api);
  },
};
