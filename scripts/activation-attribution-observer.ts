/**
 * Diagnostic observer for the activation-attribution campaign. Loaded in BOTH arms; it drives the
 * shared harness symmetrically. Readiness differs only in whether the sidebar painted rows, which
 * is exactly the treatment under test. The same K host events are injected into both arms so their
 * emission cost cancels and only the product's reaction to them is measured.
 */

import assert from "node:assert/strict";
import { rename, writeFile } from "node:fs/promises";
import { snapshot, type AttributionState } from "./activation-attribution-subject";
import { attributionCriteria } from "./lib/attribution-criteria";
import { startCpuProfile, type CpuProfiler } from "./lib/cpu-profile";

const arm = process.env.SIDEBAR_ATTRIBUTION_ARM === "product" ? "product" : "control";
const output = process.env.SIDEBAR_ATTRIBUTION_OUTPUT!;
const idleMs = Number(
  process.env.SIDEBAR_ATTRIBUTION_IDLE_MS ?? attributionCriteria.windows.idleMs,
);
const eventCount = Number(process.env.SIDEBAR_ATTRIBUTION_EVENTS ?? 0);
const settleMs = Number(process.env.SIDEBAR_ATTRIBUTION_SETTLE_MS ?? 0);
const profileRequested = process.env.SIDEBAR_ATTRIBUTION_PROFILE === "1";

const state = (): AttributionState => (globalThis as any).__sidebarActivationAttribution;

async function until(fn: () => boolean, label: string, timeoutMs = 30_000): Promise<void> {
  const started = performance.now();
  while (!fn()) {
    assert(performance.now() - started < timeoutMs, label);
    await Bun.sleep(25);
  }
}

function rendered(api: any): string {
  return api.renderer.currentRenderBuffer
    .getSpanLines()
    .map((line: any) => line.spans.map((span: any) => span.text).join(""))
    .join("\n");
}

function tree(api: any): { nodes: number; rows: number } {
  const pending = [api.renderer.root];
  let nodes = 0;
  let rows = 0;
  while (pending.length > 0) {
    const node = pending.pop();
    nodes += 1;
    if (node.id.startsWith("sidebar-session-") && node.id.endsWith("-window")) rows += 1;
    pending.push(...node.getChildren());
  }
  return { nodes, rows };
}

async function measure(api: any): Promise<void> {
  const result: any = {
    arm,
    completed: false,
    snapshots: [],
    injectedEvents: 0,
    deliveredEvents: 0,
  };
  try {
    assert.equal(api.app.version, process.env.SIDEBAR_TEST_OPENCODE_VERSION);
    const directory = process.env.SIDEBAR_ATTRIBUTION_DIRECTORY;
    const selected = process.env.SIDEBAR_ATTRIBUTION_SESSION;
    assert(directory, "missing attribution directory");
    assert(selected, "missing attribution session");
    const sessions = await api.client.session.list(
      { directory, limit: 250 },
      { throwOnError: true },
    );
    assert.equal(sessions.data.length, 250);
    api.route.navigate("session", { sessionID: selected });
    await until(() => {
      const text = rendered(api);
      return (
        api.state.ready &&
        api.route.current.params?.sessionID === selected &&
        text.includes("Context") &&
        text.includes("0 tokens")
      );
    }, "Native session not ready");
    await until(() => tree(api).rows > 0 === (arm === "product"), "Unexpected sidebar geometry");
    snapshot("ready");
    // Optional settle so a steady-state run can exclude the transient that follows seeding and the
    // first render; the measured window then starts at the post-settle "settled" snapshot.
    if (settleMs > 0) await Bun.sleep(settleMs);
    snapshot("settled");
    for (let index = 0; index < eventCount; index += 1) {
      await api.client.session.create(
        { directory, title: `Synthetic attribution event ${index + 1}` },
        { throwOnError: true },
      );
      state().injectedEvents = index + 1;
      await Bun.sleep(50);
    }
    snapshot("after-events");
    // The profile covers exactly the idle window: started after the last pre-idle snapshot and
    // stopped as soon as the idle sleep ends. If the host lacks node:inspector we keep the CPU-time
    // measurement and record the reason instead of failing the arm.
    let profiler: CpuProfiler | undefined;
    let profileError: string | undefined;
    if (profileRequested) {
      try {
        profiler = await startCpuProfile();
      } catch (error) {
        profileError = String(error);
      }
    }
    await Bun.sleep(idleMs);
    // Stop the profile before the closing snapshot so the snapshot's heap walk (heapStats) stays
    // out of the captured window and does not masquerade as product CPU.
    if (profiler) {
      try {
        const captured = await profiler.stop();
        await writeFile(`${output}.cpuprofile`, JSON.stringify(captured));
        profiler = undefined;
      } catch (error) {
        profileError = String(error);
      }
    }
    snapshot("ready+idle");
    result.profile = profileRequested
      ? { requested: true, captured: profileError === undefined, error: profileError }
      : undefined;
    result.completed = true;
  } catch (error) {
    result.failure = String(error);
  } finally {
    result.snapshots = state().snapshots;
    result.injectedEvents = state().injectedEvents;
    result.deliveredEvents = state().deliveredEvents;
    await writeFile(`${output}.tmp`, JSON.stringify(result));
    await rename(`${output}.tmp`, output);
  }
}

export default {
  id: "synthetic-activation-attribution-observer",
  async tui(api: any) {
    void measure(api);
  },
};
