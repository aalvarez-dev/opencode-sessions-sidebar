/** Instrumented phase observation. No forced GC; not a resource-acceptance observer. */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { snapshot } from "./memory-phase-subject";
const state = () => (globalThis as any).__sidebarMemoryPhases;
const mode = process.env.SIDEBAR_MEMORY_MODE!;
const output = process.env.SIDEBAR_MEMORY_OUTPUT!;
const preflight = process.env.SIDEBAR_MEMORY_PREFLIGHT === "true";
async function until(fn: () => boolean, label: string) {
  const started = performance.now();
  while (!fn()) {
    assert(performance.now() - started < 25_000, label);
    await Bun.sleep(25);
  }
}
function tree(api: any) {
  const pending = [api.renderer.root];
  let nodes = 0,
    rows = 0,
    texts = 0;
  while (pending.length) {
    const n = pending.pop();
    nodes++;
    if (n.id.startsWith("sidebar-session-") && n.id.endsWith("-window")) rows++;
    if ("plainText" in n && "textLength" in n) texts++;
    pending.push(...n.getChildren());
  }
  return { nodes, rows, texts };
}
async function measure(api: any) {
  const result: any = {
    completed: false,
    acceptanceEvaluated: false,
    mode,
    snapshots: state().snapshots,
    calls: state().calls,
    trees: [],
  };
  try {
    assert.equal(api.app.version, process.env.SIDEBAR_TEST_OPENCODE_VERSION);
    const directory = process.env.SIDEBAR_MEMORY_DIRECTORY;
    const selected = process.env.SIDEBAR_MEMORY_SESSION;
    const sessions = await api.client.session.list(
      { directory, limit: 250 },
      { throwOnError: true },
    );
    assert.equal(sessions.data.length, 250);
    const title = sessions.data.find((s: any) => s.id === selected).title;
    api.route.navigate("session", { sessionID: selected });
    await until(() => {
      const text = api.renderer.currentRenderBuffer
        .getSpanLines()
        .map((l: any) => l.spans.map((s: any) => s.text).join(""))
        .join("\n");
      return (
        api.state.ready &&
        api.route.current.params?.sessionID === selected &&
        text.includes(title) &&
        text.includes("Context") &&
        text.includes("0 tokens")
      );
    }, "Native session not ready");
    if (mode === "data" || mode === "full")
      await until(
        () => state().calls.length >= 5 && state().pending === 0,
        "Data activation not ready",
      );
    await until(() => tree(api).rows > 0 === (mode === "full"), "Unexpected sidebar geometry");
    result.trees.push({ phase: "ready", ...tree(api) });
    await snapshot("ready", api);
    for (const [phase, delay] of preflight
      ? [["preflight", 500]]
      : [
          ["ready+20s", 20_000],
          ["ready+45s", 25_000],
        ]) {
      await Bun.sleep(delay as number);
      await snapshot(phase as string, api);
    }
    result.trees.push({ phase: "end", ...tree(api) });
    if (mode === "full" || mode === "data") {
      assert(await api.plugins.deactivate("synthetic-memory-subject"));
      await until(() => tree(api).rows === 0, "Disposal retained rows");
      await snapshot("deactivated", api);
      assert.equal(state().liveListeners, 0);
      assert.equal(state().pending, 0);
      if (mode === "full" && !preflight) {
        await Bun.sleep(10_000);
        await snapshot("deactivated+10s", api);
        assert(await api.plugins.activate("synthetic-memory-subject"));
        await until(() => tree(api).rows > 0 && state().pending === 0, "Reactivation failed");
        await Bun.sleep(10_000);
        await snapshot("reactivated+10s", api);
        assert(await api.plugins.deactivate("synthetic-memory-subject"));
        assert.equal(state().liveListeners, 0);
        assert.equal(state().pending, 0);
      }
    }
    assert(
      !state().calls.some((c: any) => c.method === "global.health"),
      "Unexpected health call in startup-only diagnostic",
    );
    result.completed = true;
  } catch (error) {
    result.failure = String(error);
  } finally {
    await writeFile(output, JSON.stringify(result));
  }
}
export default {
  id: "synthetic-memory-observer",
  async tui(api: any) {
    void measure(api);
  },
};
