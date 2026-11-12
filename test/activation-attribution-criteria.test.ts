import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { attributionCriteria, attributionWindows } from "../scripts/lib/attribution-criteria";

test("criteria keep their pre-registered values", () => {
  expect(attributionCriteria.pairs).toBe(10);
  expect(attributionCriteria.warmupPairsDiscarded).toBe(2);
  expect(attributionCriteria.minEvaluablePairs).toBe(5);
  expect(attributionCriteria.extensionMaxPairs).toBe(16);
  expect(attributionCriteria.sessions).toBe(250);
  expect(attributionCriteria.budget).toEqual({ rssMiB: 64, cpuPoints: 1 });
  expect(attributionCriteria.signalIqrMultiple).toBe(3);
  expect(attributionCriteria.windows).toEqual({
    baselineMs: 30_000,
    idleMs: 70_000,
    sampleIntervalMs: 1_000,
  });
  expect(attributionWindows.total).toEqual({ from: "before-import", to: "ready+idle" });
});

test("committed criteria document matches the pre-registered values", async () => {
  const document = await readFile(
    join(import.meta.dir, "..", "docs/validation/activation-attribution-criteria.md"),
    "utf8",
  );
  for (const token of [
    "10 pairs",
    "5 evaluable",
    "16",
    "250",
    "64 MiB",
    "1.0 point",
    "3×IQR",
    "30 s",
    "70 s",
    "1 Hz",
  ]) {
    expect(document).toContain(token);
  }
});
