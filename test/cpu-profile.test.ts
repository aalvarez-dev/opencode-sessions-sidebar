import { expect, test } from "bun:test";
import { cpuProfileSupport, startCpuProfile } from "../scripts/lib/cpu-profile";

test("reports support without throwing", async () => {
  const support = await cpuProfileSupport();
  expect(typeof support.available).toBe("boolean");
  if (!support.available) expect(typeof support.reason).toBe("string");
});

test("captures a bounded profile when the host embeds node:inspector", async () => {
  const support = await cpuProfileSupport();
  if (!support.available) {
    // A host build that trims node:inspector must degrade, never crash the diagnostic.
    expect(support.available).toBe(false);
    return;
  }
  const profiler = await startCpuProfile(1000);
  // Burn a little synchronous CPU so at least one sample lands inside the window.
  let acc = 0;
  const deadline = Date.now() + 30;
  while (Date.now() < deadline) acc += Math.sqrt(acc + 1);
  const profile = await profiler.stop();
  expect(Array.isArray(profile.nodes)).toBe(true);
  expect(profile.nodes.length).toBeGreaterThan(0);
  expect(acc).toBeGreaterThan(0);
});
