import { expect, test } from "bun:test";
import {
  collectWindowSamples,
  decideVerdict,
  type ArmRun,
  type CampaignReport,
  type PairRun,
  type SnapshotMetrics,
} from "../scripts/lib/memory-deltas";

// The steady window is "settled" -> "ready+idle": 70_000 ms of idle after a settle.
const IDLE_MS = 70_000;

function snap(phase: string, cpuUsec: number, elapsedMs: number, rssMiB: number): SnapshotMetrics {
  return {
    phase,
    elapsedMs,
    rssMiB,
    heapSizeMiB: 0,
    heapCapacityMiB: 0,
    currentCommitMiB: 0,
    externalMiB: 0,
    objectCount: 0,
    cpuUsec,
  };
}

function arm(name: "product" | "control", idleCpuMicros: number): ArmRun {
  const base = 5_000_000;
  return {
    arm: name,
    completed: true,
    injectedEvents: 0,
    deliveredEvents: 0,
    snapshots: [
      snap("ready", 0, 0, 200),
      snap("settled", base, 0, 200),
      snap("after-events", base, 0, 200),
      snap("ready+idle", base + idleCpuMicros, IDLE_MS, 200),
    ],
  };
}

function report(idleCpuMicros: readonly { product: number; control: number }[]): CampaignReport {
  const pairs: PairRun[] = idleCpuMicros.map((item, index) => ({
    index,
    order: ["product", "control"],
    product: arm("product", item.product),
    control: arm("control", item.control),
  }));
  return { pairs };
}

const criteria = {
  budgetRssMiB: 64,
  budgetCpuPoints: 1,
  signalIqrMultiple: 3,
  minEvaluablePairs: 5,
};

// cpuPoints = micros / (10 * elapsedMs); +2 points over 70_000 ms == 1_400_000 microseconds.
const TWO_POINTS = 2 * IDLE_MS * 10;
const HALF_POINT = 0.5 * IDLE_MS * 10;

test("steady window excludes the settle snapshot and fails above the CPU budget", () => {
  const data = report([
    { product: TWO_POINTS, control: 0 },
    { product: TWO_POINTS, control: 0 },
    { product: TWO_POINTS, control: 0 },
    { product: TWO_POINTS, control: 0 },
    { product: TWO_POINTS, control: 0 },
    { product: TWO_POINTS, control: 0 },
    { product: TWO_POINTS, control: 0 },
  ]);
  const samples = collectWindowSamples(data, "settled", "ready+idle", 2);
  expect(samples.evaluablePairs).toBe(5);
  const verdict = decideVerdict({ rss: samples.rss, cpu: samples.cpu }, criteria);
  expect(verdict.verdict).toBe("FAIL_CPU");
  expect(verdict.cpu.median).toBeCloseTo(2, 6);
});

test("steady window passes when idle CPU stays under the budget", () => {
  const data = report(Array.from({ length: 7 }, () => ({ product: HALF_POINT, control: 0 })));
  const samples = collectWindowSamples(data, "settled", "ready+idle", 2);
  const verdict = decideVerdict({ rss: samples.rss, cpu: samples.cpu }, criteria);
  expect(verdict.verdict).toBe("PASS");
  expect(verdict.cpu.median).toBeCloseTo(0.5, 6);
});

test("steady window is inconclusive when too few pairs are evaluable", () => {
  const data = report([
    { product: TWO_POINTS, control: 0 },
    { product: TWO_POINTS, control: 0 },
    { product: TWO_POINTS, control: 0 },
    { product: TWO_POINTS, control: 0 },
  ]);
  const samples = collectWindowSamples(data, "settled", "ready+idle", 2);
  // 4 pairs, 2 discarded as warm-up -> 2 evaluable, below the 5-pair floor.
  const verdict = decideVerdict({ rss: samples.rss, cpu: samples.cpu }, criteria);
  expect(samples.evaluablePairs).toBe(2);
  expect(verdict.verdict).toBe("INCONCLUSIVE");
});
