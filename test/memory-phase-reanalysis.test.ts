import { expect, test } from "bun:test";
import {
  basePhase,
  reanalyzePhaseReport,
  type PhaseReport,
} from "../scripts/lib/memory-phase-reanalysis";

const MIB = 1024 * 1024;

function phase(name: string, rssMiB: number, heapMiB = 0, objectCount = 0) {
  return {
    phase: name,
    memory: { rss: rssMiB * MIB },
    heap: { heapSize: heapMiB * MIB, objectCount },
  };
}

test("basePhase strips the activation counter", () => {
  expect(basePhase("before-import-1")).toBe("before-import");
  expect(basePhase("after-activate-2")).toBe("after-activate");
  expect(basePhase("ready+45s")).toBe("ready+45s");
});

test("reanalyze computes within-process deltas per mode", () => {
  const report: PhaseReport = {
    results: [
      {
        label: "1-control",
        mode: "control",
        completed: true,
        snapshots: [phase("before-import-1", 2), phase("after-import-1", 2)],
      },
      {
        label: "2-full",
        mode: "full",
        completed: true,
        snapshots: [
          phase("before-import-1", 2, 5, 100),
          phase("after-import-1", 3, 6, 120),
          phase("after-activate-1", 4, 7, 150),
          phase("ready", 4, 7, 150),
          phase("ready+45s", 5, 8, 160),
          phase("deactivated", 3, 6, 120),
        ],
      },
    ],
  };
  const result = reanalyzePhaseReport(report);
  expect(result.modes[0]!.importRssMiB).toBe(0);
  const full = result.modes[1]!;
  expect(full.importRssMiB).toBeCloseTo(1, 6);
  expect(full.importHeapMiB).toBeCloseTo(1, 6);
  expect(full.activationRssMiB).toBeCloseTo(2, 6);
  expect(full.activationObjectCount).toBe(50);
  expect(full.idle45RssMiB).toBeCloseTo(1, 6);
  expect(full.deactivationRssMiB).toBeCloseTo(-2, 6);
  expect(result.byMode.full!.count).toBe(1);
  expect(result.byMode.full!.medianActivationRssMiB).toBeCloseTo(2, 6);
});
