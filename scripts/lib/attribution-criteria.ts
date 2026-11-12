/**
 * Pre-registered activation-attribution criteria.
 *
 * Committed BEFORE any measured run and never edited afterwards without a separate, reviewed
 * change (and a note in `docs/validation/activation-attribution-criteria.md`). It is the single
 * source of truth imported by the campaign driver and the analyzer, so the verdict cannot drift
 * from the design that was declared in advance.
 */

export interface AttributionWindows {
  /** Stabilization before the first measured sample, in milliseconds. */
  readonly baselineMs: number;
  /** Idle observation window, long enough to pass an idle full-GC plateau, in milliseconds. */
  readonly idleMs: number;
  /** Target sampling period for the idle time series, in milliseconds. */
  readonly sampleIntervalMs: number;
}

export interface AttributionCriteria {
  /** Total paired processes to run before warm-up discard. */
  readonly pairs: number;
  /** Leading pairs dropped as JIT/warm-up; declared in advance, never chosen after the fact. */
  readonly warmupPairsDiscarded: number;
  /** Minimum evaluable pairs; below this the verdict is INCONCLUSIVE, never PASS. */
  readonly minEvaluablePairs: number;
  /** A single pre-declared extension ceiling when the first verdict is INCONCLUSIVE. */
  readonly extensionMaxPairs: number;
  /** Idle synthetic sessions in the seeded host. */
  readonly sessions: number;
  /** Original, unchanged acceptance budgets. */
  readonly budget: { readonly rssMiB: number; readonly cpuPoints: number };
  /** A delta only counts as a real increase if it exceeds this multiple of its IQR. */
  readonly signalIqrMultiple: number;
  readonly windows: AttributionWindows;
  /** Idle checkpoints (seconds after ready) reported for the CPU decay curve. */
  readonly idleCheckpointsSeconds: readonly number[];
}

export const attributionCriteria: AttributionCriteria = {
  pairs: 10,
  warmupPairsDiscarded: 2,
  minEvaluablePairs: 5,
  extensionMaxPairs: 16,
  sessions: 250,
  budget: { rssMiB: 64, cpuPoints: 1 },
  signalIqrMultiple: 3,
  windows: { baselineMs: 30_000, idleMs: 70_000, sampleIntervalMs: 1_000 },
  idleCheckpointsSeconds: [0, 2, 5, 10, 20, 30, 70],
};

/** The comparison window headline and the per-phase windows the analyzer reports. */
export const attributionWindows = {
  /** First import + first activation + idle: the headline footprint the budget applies to. */
  total: { from: "before-import", to: "ready+idle" } as const,
  /** First import only (within an already-started process). */
  import: { from: "before-import", to: "after-import" } as const,
  /** First activation over the post-import module graph. */
  activation: { from: "after-import", to: "after-activate" } as const,
  /** Event-driven update window (host events injected in both arms). */
  events: { from: "ready", to: "after-events" } as const,
  /** Sustained idle window after events settle. */
  idle: { from: "after-events", to: "ready+idle" } as const,
} as const;

export type AttributionWindowName = keyof typeof attributionWindows;
