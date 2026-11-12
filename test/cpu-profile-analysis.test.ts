import { expect, test } from "bun:test";
import type { CpuProfile } from "../scripts/lib/cpu-profile";
import { classifyFrame, summarizeProfile } from "../scripts/lib/cpu-profile-analysis";

test("classifies frames into exactly one bucket", () => {
  expect(classifyFrame("bundle:///dist/tui.js", "activateSidebar")).toBe("plugin");
  expect(classifyFrame("file:///@opentui/core/renderer.ts", "render")).toBe("host-opentui");
  expect(classifyFrame("file:///node_modules/solid-js/dist/solid.js", "updateComputation")).toBe(
    "host-solid",
  );
  expect(classifyFrame("node:internal/timers", "listOnTimeout")).toBe("host-runtime");
  expect(classifyFrame("", "GC")).toBe("gc");
  expect(classifyFrame("", "setInterval")).toBe("timer");
  expect(classifyFrame("", "")).toBe("idle");
});

test("aggregates self time from samples and timeDeltas", () => {
  const profile: CpuProfile = {
    startTime: 0,
    endTime: 4000,
    nodes: [
      { id: 1, callFrame: { functionName: "root", url: "", lineNumber: 0, columnNumber: 0 } },
      {
        id: 2,
        callFrame: {
          functionName: "render",
          url: "file:///@opentui/core/renderer.ts",
          lineNumber: 10,
          columnNumber: 0,
        },
      },
      { id: 3, callFrame: { functionName: "GC", url: "", lineNumber: 0, columnNumber: 0 } },
    ],
    samples: [2, 2, 3, 1],
    timeDeltas: [1000, 1000, 500, 1500],
  };
  const summary = summarizeProfile(profile);
  expect(summary.totalMicros).toBe(4000);
  const byBucket = Object.fromEntries(summary.buckets.map((b) => [b.bucket, b.selfMicros]));
  expect(byBucket["host-opentui"]).toBe(2000);
  expect(byBucket["gc"]).toBe(500);
  expect(summary.topFrames[0]!.functionName).toBe("render");
  expect(summary.topFrames[0]!.selfMicros).toBe(2000);
});

test("falls back to hitCount when samples are absent", () => {
  const profile: CpuProfile = {
    startTime: 0,
    endTime: 0,
    nodes: [
      {
        id: 1,
        callFrame: { functionName: "x", url: "bundle:///dist/tui.js", lineNumber: 1, columnNumber: 0 },
        hitCount: 7,
      },
    ],
  };
  const summary = summarizeProfile(profile);
  expect(summary.totalMicros).toBe(7);
  expect(summary.buckets[0]!.bucket).toBe("plugin");
});
