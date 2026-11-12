/**
 * Pure aggregation of a Chrome DevTools CPU profile into self-time buckets.
 *
 * The diagnostic needs to answer one question about the idle window: is the CPU spent in the
 * plugin, the host renderer, GC, timers, or is it actually idle? This module turns a captured
 * profile into ranked buckets and heaviest frames without any live host, so it is unit-testable.
 */

import type { CpuProfile, CpuProfileNode } from "./cpu-profile";

export type FrameBucket =
  | "plugin"
  | "host-opentui"
  | "host-solid"
  | "host-runtime"
  | "gc"
  | "timer"
  | "host-other"
  | "synthetic"
  | "idle";

export interface FrameSample {
  readonly functionName: string;
  readonly url: string;
  readonly line: number;
  readonly selfMicros: number;
}

export interface BucketSummary {
  readonly bucket: FrameBucket;
  readonly selfMicros: number;
  readonly samples: number;
}

export interface ProfileSummary {
  readonly totalMicros: number;
  readonly buckets: readonly BucketSummary[];
  readonly topFrames: readonly FrameSample[];
}

const GARBAGE = /gc|garbage|scaven|marking|sweep|evacuat|collect/i;
const TIMER = /setTimeout|setInterval|listOnTimeout|processTimers|timer/i;

/** Classify a profile frame by its URL and function name into exactly one bucket. */
export function classifyFrame(url: string, functionName: string): FrameBucket {
  const u = url || "";
  const n = functionName || "";
  if (u.includes("activation-attribution") || u.includes("dist/tui") || u.includes("/scripts/")) {
    return "plugin";
  }
  if (GARBAGE.test(n)) return "gc";
  if (/@opentui|opentui/i.test(u)) return "host-opentui";
  if (/solid-js/i.test(u)) return "host-solid";
  if (/^node:|^bun:|^internal\//.test(u)) return "host-runtime";
  if (TIMER.test(n)) return "timer";
  if (u) return "host-other";
  if (n) return "synthetic";
  return "idle";
}

function selfTimeByNode(profile: CpuProfile): Map<number, number> {
  const self = new Map<number, number>();
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  if (samples.length > 0 && deltas.length > 0) {
    for (let index = 0; index < samples.length; index += 1) {
      const nodeId = samples[index]!;
      const micros = deltas[index] ?? 0;
      self.set(nodeId, (self.get(nodeId) ?? 0) + micros);
    }
    return self;
  }
  for (const node of profile.nodes) {
    if (typeof node.hitCount === "number") self.set(node.id, node.hitCount);
  }
  return self;
}

/** Aggregate the profile into self-time buckets and the heaviest individual frames. */
export function summarizeProfile(profile: CpuProfile, topFrameCount = 15): ProfileSummary {
  const self = selfTimeByNode(profile);
  const nodeById = new Map<number, CpuProfileNode>();
  for (const node of profile.nodes) nodeById.set(node.id, node);
  const bucketMicros = new Map<FrameBucket, number>();
  const bucketSamples = new Map<FrameBucket, number>();
  const frames: FrameSample[] = [];
  let totalMicros = 0;
  const ranked = [...self.entries()].sort((a, b) => b[1] - a[1]);
  for (const [nodeId, micros] of ranked) {
    totalMicros += micros;
    const frame = nodeById.get(nodeId)?.callFrame;
    const bucket = classifyFrame(frame?.url ?? "", frame?.functionName ?? "");
    bucketMicros.set(bucket, (bucketMicros.get(bucket) ?? 0) + micros);
    bucketSamples.set(bucket, (bucketSamples.get(bucket) ?? 0) + 1);
    if (frame) {
      frames.push({
        functionName: frame.functionName || "(anonymous)",
        url: frame.url || "",
        line: frame.lineNumber,
        selfMicros: micros,
      });
    }
  }
  const buckets = [...bucketMicros.entries()]
    .map(([bucket, selfMicros]) => ({
      bucket,
      selfMicros,
      samples: bucketSamples.get(bucket) ?? 0,
    }))
    .sort((a, b) => b.selfMicros - a.selfMicros);
  return { totalMicros, buckets, topFrames: frames.slice(0, topFrameCount) };
}
