/**
 * Pure within-process delta and difference-in-differences math.
 *
 * No I/O, no clock, no GC: every function is deterministic given its inputs, which is what makes
 * the analyzer unit-testable without running a campaign. The central idea is that a delta computed
 * inside one already-started process cancels the host's startup variance, and the paired
 * difference-in-differences against a symmetric control cancels the shared harness cost.
 */

/** Metric keys carried through every delta and DiD computation. */
export const memoryMetricKeys = [
  "rssMiB",
  "heapSizeMiB",
  "currentCommitMiB",
  "externalMiB",
  "objectCount",
] as const;

export type MemoryMetric = (typeof memoryMetricKeys)[number];

export interface SnapshotMetrics {
  readonly phase: string;
  readonly elapsedMs: number;
  readonly rssMiB: number;
  readonly heapSizeMiB: number;
  readonly heapCapacityMiB: number;
  readonly currentCommitMiB: number;
  readonly externalMiB: number;
  readonly objectCount: number;
  /** Cumulative process CPU (user+system) in microseconds at this snapshot. */
  readonly cpuUsec: number;
}

export type Arm = "product" | "control";

export interface ArmRun {
  readonly arm: Arm;
  readonly completed: boolean;
  readonly snapshots: readonly SnapshotMetrics[];
  readonly injectedEvents: number;
  readonly deliveredEvents: number;
  readonly failure?: string;
}

export interface PairRun {
  readonly index: number;
  readonly order: readonly Arm[];
  readonly product: ArmRun;
  readonly control: ArmRun;
}

export interface CampaignReport {
  readonly pairs: readonly PairRun[];
}

export type MetricDelta = Partial<Record<MemoryMetric, number>>;

function findPhase(arm: ArmRun, phase: string): SnapshotMetrics | undefined {
  return arm.snapshots.find((snapshot) => snapshot.phase === phase);
}

/** Post-minus-pre delta within a single arm's process. */
export function withinProcessDelta(arm: ArmRun, fromPhase: string, toPhase: string): MetricDelta {
  const before = findPhase(arm, fromPhase);
  const after = findPhase(arm, toPhase);
  if (!before || !after) return {};
  const delta: MetricDelta = {};
  for (const metric of memoryMetricKeys) delta[metric] = after[metric] - before[metric];
  return delta;
}

export interface DidValue {
  readonly metric: MemoryMetric;
  readonly product: number;
  readonly control: number;
  readonly did: number;
}

/** Per-metric difference-in-differences: product delta minus control delta. */
export function pairDid(pair: PairRun, fromPhase: string, toPhase: string): DidValue[] {
  const product = withinProcessDelta(pair.product, fromPhase, toPhase);
  const control = withinProcessDelta(pair.control, fromPhase, toPhase);
  const values: DidValue[] = [];
  for (const metric of memoryMetricKeys) {
    const p = product[metric];
    const c = control[metric];
    if (p === undefined || c === undefined) continue;
    values.push({ metric, product: p, control: c, did: p - c });
  }
  return values;
}

/** Whole-process CPU as percentage points over a phase window. */
export function cpuPointsBetween(
  arm: ArmRun,
  fromPhase: string,
  toPhase: string,
): number | undefined {
  const before = findPhase(arm, fromPhase);
  const after = findPhase(arm, toPhase);
  if (!before || !after) return undefined;
  const micros = after.cpuUsec - before.cpuUsec;
  const elapsed = after.elapsedMs - before.elapsedMs;
  if (micros < 0 || !(elapsed > 0)) return undefined;
  return (micros / 1000 / elapsed) * 100;
}

export interface WindowDid {
  readonly rss: number;
  readonly cpuPoints: number;
}

/** Paired RSS and CPU difference-in-differences over one window. */
export function pairWindowDid(
  pair: PairRun,
  fromPhase: string,
  toPhase: string,
): WindowDid | undefined {
  const productRss = withinProcessDelta(pair.product, fromPhase, toPhase).rssMiB;
  const controlRss = withinProcessDelta(pair.control, fromPhase, toPhase).rssMiB;
  const productCpu = cpuPointsBetween(pair.product, fromPhase, toPhase);
  const controlCpu = cpuPointsBetween(pair.control, fromPhase, toPhase);
  if (
    productRss === undefined ||
    controlRss === undefined ||
    productCpu === undefined ||
    controlCpu === undefined
  )
    return undefined;
  return { rss: productRss - controlRss, cpuPoints: productCpu - controlCpu };
}

export function sortedCopy(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

/** Linear-interpolation quantile; NaN for empty input, never a silent zero. */
export function quantile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = sortedCopy(values);
  if (sorted.length === 1) return sorted[0]!;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  const low = sorted[lower]!;
  const high = sorted[upper]!;
  return low + (high - low) * weight;
}

export function median(values: readonly number[]): number {
  return quantile(values, 0.5);
}

export function interquartileRange(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  return quantile(values, 0.75) - quantile(values, 0.25);
}

export interface VerdictCriteria {
  readonly budgetRssMiB: number;
  readonly budgetCpuPoints: number;
  readonly signalIqrMultiple: number;
  readonly minEvaluablePairs: number;
}

export type MetricVerdict = "PASS" | "FAIL" | "INCONCLUSIVE";
export type Verdict = "PASS" | "FAIL_RSS" | "FAIL_CPU" | "FAIL_RSS_AND_CPU" | "INCONCLUSIVE";

export interface MetricAssessment {
  readonly metric: "rss" | "cpu";
  readonly evaluable: number;
  readonly median: number;
  readonly iqr: number;
  readonly budget: number;
  readonly verdict: MetricVerdict;
}

export interface VerdictResult {
  readonly verdict: Verdict;
  readonly rss: MetricAssessment;
  readonly cpu: MetricAssessment;
  readonly evaluablePairs: number;
}

function assessMetric(
  metric: "rss" | "cpu",
  samples: readonly number[],
  budget: number,
  criteria: VerdictCriteria,
): MetricAssessment {
  const usable = samples.filter((value) => Number.isFinite(value));
  const med = median(usable);
  const spread = interquartileRange(usable);
  let verdict: MetricVerdict = "PASS";
  if (usable.length < criteria.minEvaluablePairs) {
    verdict = "INCONCLUSIVE";
  } else if (med > budget) {
    verdict = med > criteria.signalIqrMultiple * spread ? "FAIL" : "INCONCLUSIVE";
  } else if (spread > budget) {
    verdict = "INCONCLUSIVE";
  }
  return { metric, evaluable: usable.length, median: med, iqr: spread, budget, verdict };
}

/**
 * Decide the campaign verdict. A metric only FAILS when its median exceeds the budget AND the
 * signal exceeds `signalIqrMultiple` times its own IQR; an over-budget but noisy median, or noise
 * larger than the budget, is INCONCLUSIVE rather than a false PASS or a false FAIL.
 */
export function decideVerdict(
  samples: { readonly rss: readonly number[]; readonly cpu: readonly number[] },
  criteria: VerdictCriteria,
): VerdictResult {
  const rss = assessMetric("rss", samples.rss, criteria.budgetRssMiB, criteria);
  const cpu = assessMetric("cpu", samples.cpu, criteria.budgetCpuPoints, criteria);
  const evaluablePairs = Math.min(rss.evaluable, cpu.evaluable);
  let verdict: Verdict;
  const failRss = rss.verdict === "FAIL";
  const failCpu = cpu.verdict === "FAIL";
  if (failRss && failCpu) verdict = "FAIL_RSS_AND_CPU";
  else if (failRss) verdict = "FAIL_RSS";
  else if (failCpu) verdict = "FAIL_CPU";
  else if (rss.verdict === "INCONCLUSIVE" || cpu.verdict === "INCONCLUSIVE")
    verdict = "INCONCLUSIVE";
  else verdict = "PASS";
  return { verdict, rss, cpu, evaluablePairs };
}

export interface WindowSamples {
  readonly rss: readonly number[];
  readonly cpu: readonly number[];
  readonly evaluablePairs: number;
  readonly totalPairs: number;
  readonly droppedPairs: readonly number[];
  readonly warmupDiscarded: readonly number[];
}

/**
 * Collect per-pair DiD samples for one window, dropping the declared warm-up pairs first and then
 * any pair whose arms did not both complete. Dropped pairs are returned, never silently removed,
 * so a campaign cannot quietly shrink its own sample.
 */
export function collectWindowSamples(
  report: CampaignReport,
  fromPhase: string,
  toPhase: string,
  warmupPairsDiscarded: number,
): WindowSamples {
  const ordered = [...report.pairs].sort((a, b) => a.index - b.index);
  const warmup = ordered.slice(0, warmupPairsDiscarded).map((pair) => pair.index);
  const evaluable = ordered.slice(warmupPairsDiscarded);
  const rss: number[] = [];
  const cpu: number[] = [];
  const droppedPairs: number[] = [];
  for (const pair of evaluable) {
    if (!pair.product.completed || !pair.control.completed) {
      droppedPairs.push(pair.index);
      continue;
    }
    const did = pairWindowDid(pair, fromPhase, toPhase);
    if (!did) {
      droppedPairs.push(pair.index);
      continue;
    }
    rss.push(did.rss);
    cpu.push(did.cpuPoints);
  }
  return {
    rss,
    cpu,
    evaluablePairs: rss.length,
    totalPairs: ordered.length,
    droppedPairs,
    warmupDiscarded: warmup,
  };
}
