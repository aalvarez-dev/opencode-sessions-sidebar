/**
 * Diagnostic subject for the activation-attribution campaign; never installable or acceptance.
 *
 * Loaded in BOTH arms. Only the treatment arm imports the built product from `dist/` and activates
 * it; the control arm imports nothing from `dist/` and does no activation. The paired observer
 * drives readiness, event injection and timed snapshots for both arms, so the harness is symmetric
 * and the paired difference-in-differences cancels it. Nothing here wraps the product: the goal is
 * to measure its native first import + first activation cost, not an instrumented copy of it.
 */

import { heapStats, memoryUsage } from "bun:jsc";
import type { SnapshotMetrics } from "./lib/memory-deltas";

const key = "__sidebarActivationAttribution";
const root = globalThis as any;

export interface AttributionState {
  readonly snapshots: SnapshotMetrics[];
  injectedEvents: number;
  deliveredEvents: number;
}

const state: AttributionState = (root[key] ??= {
  snapshots: [],
  injectedEvents: 0,
  deliveredEvents: 0,
});

function mebibytes(bytes: number): number {
  return bytes / 1024 / 1024;
}

/** Capture RSS, JSC heap, allocator commit and cumulative CPU at one named phase. */
export function snapshot(phase: string): SnapshotMetrics {
  const usage = process.memoryUsage();
  const heap = heapStats() as any;
  const commit = (memoryUsage() as any).currentCommit;
  const cpu = process.cpuUsage();
  const item: SnapshotMetrics = {
    phase,
    elapsedMs: performance.now(),
    rssMiB: mebibytes(usage.rss),
    heapSizeMiB: mebibytes(heap?.heapSize ?? 0),
    heapCapacityMiB: mebibytes(heap?.heapCapacity ?? 0),
    currentCommitMiB: typeof commit === "number" ? mebibytes(commit) : 0,
    externalMiB: mebibytes(usage.external ?? 0),
    objectCount: heap?.objectCount ?? 0,
    cpuUsec: cpu.user + cpu.system,
  };
  state.snapshots.push(item);
  return item;
}

export default {
  id: "synthetic-activation-attribution-subject",
  async tui(api: any, options: any) {
    const arm = process.env.SIDEBAR_ATTRIBUTION_ARM === "product" ? "product" : "control";
    snapshot("before-import");
    if (arm === "product") {
      const product = (await import(process.env.SIDEBAR_ATTRIBUTION_PRODUCT!)).default;
      snapshot("after-import");
      await product.tui(api, options);
      snapshot("after-activate");
    } else {
      snapshot("after-import");
      snapshot("after-activate");
    }
  },
};
