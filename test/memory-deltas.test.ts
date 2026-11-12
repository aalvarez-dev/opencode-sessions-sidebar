import { expect, test } from "bun:test";
import {
  collectWindowSamples,
  cpuPointsBetween,
  decideVerdict,
  interquartileRange,
  median,
  pairDid,
  quantile,
  withinProcessDelta,
  type ArmRun,
  type CampaignReport,
  type PairRun,
  type SnapshotMetrics,
} from "../scripts/lib/memory-deltas";

function snap(phase: string, rssMiB: number, cpuUsec = 0, elapsedMs = 0): SnapshotMetrics {
  return {
    phase,
    elapsedMs,
    rssMiB,
    heapSizeMiB: rssMiB,
    heapCapacityMiB: rssMiB,
    currentCommitMiB: rssMiB,
    externalMiB: 0,
    objectCount: 0,
    cpuUsec,
  };
}

function arm(name: "product" | "control", snapshots: SnapshotMetrics[], completed = true): ArmRun {
  return { arm: name, completed, snapshots, injectedEvents: 0, deliveredEvents: 0 };
}

function pair(index: number, product: ArmRun, control: ArmRun): PairRun {
  return { index, order: ["product", "control"], product, control };
}

test("quantile and median interpolate linearly", () => {
  expect(median([1, 2, 3])).toBe(2);
  expect(median([1, 2, 3, 4])).toBe(2.5);
  expect(quantile([0, 10], 0.5)).toBe(5);
  expect(interquartileRange([1, 2, 3, 4])).toBe(1.5);
});

test("within-process delta subtracts phases inside one arm", () => {
  const treatment = arm("product", [snap("before-import", 100), snap("after-import", 130)]);
  const delta = withinProcessDelta(treatment, "before-import", "after-import");
  expect(delta.rssMiB).toBe(30);
});

test("cpu points use the window elapsed time", () => {
  const control = arm("control", [snap("a", 0, 0, 0), snap("b", 0, 200_000, 10_000)]);
  expect(cpuPointsBetween(control, "a", "b")).toBeCloseTo(2, 6);
});

test("pair DiD subtracts the control from the product", () => {
  const product = arm("product", [snap("x", 0), snap("y", 30)]);
  const control = arm("control", [snap("x", 0), snap("y", 5)]);
  const did = pairDid(pair(0, product, control), "x", "y").find(
    (entry) => entry.metric === "rssMiB",
  );
  expect(did?.did).toBe(25);
});

test("collectWindowSamples drops warm-up and incomplete pairs explicitly", () => {
  const make = (index: number, productDelta: number, controlDelta: number): PairRun =>
    pair(
      index,
      arm("product", [snap("s", 0, 0, 0), snap("e", productDelta, 100_000, 10_000)]),
      arm("control", [snap("s", 0, 0, 0), snap("e", controlDelta, 50_000, 10_000)]),
    );
  const report: CampaignReport = { pairs: [make(0, 10, 5), make(1, 20, 4), make(2, 30, 6)] };
  const samples = collectWindowSamples(report, "s", "e", 1);
  expect(samples.totalPairs).toBe(3);
  expect(samples.warmupDiscarded).toEqual([0]);
  expect(samples.evaluablePairs).toBe(2);
  expect(samples.rss).toEqual([16, 24]);
  expect(samples.cpu[0]).toBeCloseTo(0.5, 6);
});

test("decideVerdict returns PASS under budget with tight spread", () => {
  const result = decideVerdict(
    { rss: [1, 2, 3, 4, 5], cpu: [0.1, 0.2, 0.3, 0.4, 0.5] },
    { budgetRssMiB: 64, budgetCpuPoints: 1, signalIqrMultiple: 3, minEvaluablePairs: 5 },
  );
  expect(result.verdict).toBe("PASS");
});

test("decideVerdict FAILS a clear over-budget signal", () => {
  const result = decideVerdict(
    { rss: [100, 101, 102, 103, 104], cpu: [0.1, 0.2, 0.3, 0.4, 0.5] },
    { budgetRssMiB: 64, budgetCpuPoints: 1, signalIqrMultiple: 3, minEvaluablePairs: 5 },
  );
  expect(result.verdict).toBe("FAIL_RSS");
});

test("decideVerdict is INCONCLUSIVE below the minimum evaluable pairs", () => {
  const result = decideVerdict(
    { rss: [1, 2], cpu: [0.1, 0.2] },
    { budgetRssMiB: 64, budgetCpuPoints: 1, signalIqrMultiple: 3, minEvaluablePairs: 5 },
  );
  expect(result.verdict).toBe("INCONCLUSIVE");
});

test("decideVerdict is INCONCLUSIVE when spread exceeds the budget", () => {
  const result = decideVerdict(
    { rss: [0, 200, 0, 200, 0], cpu: [0, 0, 0, 0, 0] },
    { budgetRssMiB: 64, budgetCpuPoints: 1, signalIqrMultiple: 3, minEvaluablePairs: 5 },
  );
  expect(result.verdict).toBe("INCONCLUSIVE");
});
