/**
 * Pure reanalysis of the existing phase-diagnostic artifact.
 *
 * The earlier campaign compared absolute RSS between separate processes, so host startup variance
 * (measured at ~100 MiB between two controls with no product) swamped the budget. The raw artifact
 * already contains before-import / after-import / after-activate / idle snapshots inside each
 * process, so the within-process deltas can be recomputed for free, with no new run.
 */

import { median } from "./memory-deltas";

const MIB = 1024 * 1024;

export interface PhaseSnapshot {
  readonly phase: string;
  readonly memory?: { readonly rss?: number; readonly external?: number } | null;
  readonly heap?: {
    readonly heapSize?: number;
    readonly heapCapacity?: number;
    readonly objectCount?: number;
  } | null;
}

export interface PhaseResult {
  readonly label?: string;
  readonly mode?: string;
  readonly completed?: boolean;
  readonly failure?: string;
  readonly snapshots?: readonly PhaseSnapshot[];
}

export interface PhaseReport {
  readonly results?: readonly PhaseResult[];
  readonly productSha256?: string;
  readonly version?: string;
}

interface PhasePoint {
  readonly rssMiB?: number;
  readonly heapSizeMiB?: number;
  readonly objectCount?: number;
}

/** Strip the trailing activation counter, e.g. `before-import-1` -> `before-import`. */
export function basePhase(phase: string): string {
  return phase.replace(/-\d+$/, "");
}

function pointsByPhase(snapshots: readonly PhaseSnapshot[] | undefined): Map<string, PhasePoint> {
  const map = new Map<string, PhasePoint>();
  for (const snapshot of snapshots ?? []) {
    const base = basePhase(snapshot.phase);
    // First occurrence only: the first activation, not a later reactivation.
    if (map.has(base)) continue;
    const rss = snapshot.memory?.rss;
    const heapSize = snapshot.heap?.heapSize;
    const objectCount = snapshot.heap?.objectCount;
    map.set(base, {
      ...(typeof rss === "number" ? { rssMiB: rss / MIB } : {}),
      ...(typeof heapSize === "number" ? { heapSizeMiB: heapSize / MIB } : {}),
      ...(typeof objectCount === "number" ? { objectCount } : {}),
    });
  }
  return map;
}

function diff(
  points: Map<string, PhasePoint>,
  from: string,
  to: string,
  key: keyof PhasePoint,
): number | undefined {
  const before = points.get(from)?.[key];
  const after = points.get(to)?.[key];
  if (typeof before !== "number" || typeof after !== "number") return undefined;
  return after - before;
}

export interface ModeDeltas {
  readonly label: string;
  readonly mode: string;
  readonly completed: boolean;
  readonly importRssMiB?: number;
  readonly importHeapMiB?: number;
  readonly activationRssMiB?: number;
  readonly activationHeapMiB?: number;
  readonly activationObjectCount?: number;
  readonly idle45RssMiB?: number;
  readonly deactivationRssMiB?: number;
}

function modeDeltas(result: PhaseResult): ModeDeltas {
  const points = pointsByPhase(result.snapshots);
  const importRssMiB = diff(points, "before-import", "after-import", "rssMiB");
  const importHeapMiB = diff(points, "before-import", "after-import", "heapSizeMiB");
  const activationRssMiB = diff(points, "before-import", "after-activate", "rssMiB");
  const activationHeapMiB = diff(points, "before-import", "after-activate", "heapSizeMiB");
  const activationObjectCount = diff(points, "before-import", "after-activate", "objectCount");
  const idle45RssMiB = diff(points, "ready", "ready+45s", "rssMiB");
  const deactivationRssMiB = diff(points, "ready+45s", "deactivated", "rssMiB");
  return {
    label: result.label ?? result.mode ?? "unknown",
    mode: result.mode ?? "unknown",
    completed: Boolean(result.completed),
    ...(importRssMiB !== undefined ? { importRssMiB } : {}),
    ...(importHeapMiB !== undefined ? { importHeapMiB } : {}),
    ...(activationRssMiB !== undefined ? { activationRssMiB } : {}),
    ...(activationHeapMiB !== undefined ? { activationHeapMiB } : {}),
    ...(activationObjectCount !== undefined ? { activationObjectCount } : {}),
    ...(idle45RssMiB !== undefined ? { idle45RssMiB } : {}),
    ...(deactivationRssMiB !== undefined ? { deactivationRssMiB } : {}),
  };
}

export interface ModeSummary {
  readonly count: number;
  readonly medianImportRssMiB?: number;
  readonly medianActivationRssMiB?: number;
  readonly medianActivationHeapMiB?: number;
  readonly medianIdle45RssMiB?: number;
  readonly medianDeactivationRssMiB?: number;
}

function medianDefined(values: readonly (number | undefined)[]): number | undefined {
  const numbers = values.filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );
  if (numbers.length === 0) return undefined;
  return median(numbers);
}

function summarizeModes(modes: readonly ModeDeltas[]): Record<string, ModeSummary> {
  const grouped = new Map<string, ModeDeltas[]>();
  for (const mode of modes) {
    const bucket = grouped.get(mode.mode) ?? [];
    bucket.push(mode);
    grouped.set(mode.mode, bucket);
  }
  const summary: Record<string, ModeSummary> = {};
  for (const [name, bucket] of grouped) {
    const medianImportRssMiB = medianDefined(bucket.map((item) => item.importRssMiB));
    const medianActivationRssMiB = medianDefined(bucket.map((item) => item.activationRssMiB));
    const medianActivationHeapMiB = medianDefined(bucket.map((item) => item.activationHeapMiB));
    const medianIdle45RssMiB = medianDefined(bucket.map((item) => item.idle45RssMiB));
    const medianDeactivationRssMiB = medianDefined(bucket.map((item) => item.deactivationRssMiB));
    summary[name] = {
      count: bucket.length,
      ...(medianImportRssMiB !== undefined ? { medianImportRssMiB } : {}),
      ...(medianActivationRssMiB !== undefined ? { medianActivationRssMiB } : {}),
      ...(medianActivationHeapMiB !== undefined ? { medianActivationHeapMiB } : {}),
      ...(medianIdle45RssMiB !== undefined ? { medianIdle45RssMiB } : {}),
      ...(medianDeactivationRssMiB !== undefined ? { medianDeactivationRssMiB } : {}),
    };
  }
  return summary;
}

export interface PhaseReanalysis {
  readonly kind: "memory-phase-reanalysis";
  readonly note: string;
  readonly productSha256?: string;
  readonly version?: string;
  readonly modes: readonly ModeDeltas[];
  readonly byMode: Record<string, ModeSummary>;
}

export function reanalyzePhaseReport(report: PhaseReport): PhaseReanalysis {
  const modes = (report.results ?? []).map(modeDeltas);
  return {
    kind: "memory-phase-reanalysis",
    note:
      "Within-process deltas only; informative, not a statistically powered acceptance verdict. " +
      "Control import/activation deltas estimate measurement drift with no product loaded.",
    ...(report.productSha256 ? { productSha256: report.productSha256 } : {}),
    ...(report.version ? { version: report.version } : {}),
    modes,
    byMode: summarizeModes(modes),
  };
}
