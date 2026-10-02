import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

// Solid's browser conditions select its reactive runtime, shared by OpenCode.
// The default Bun conditions select SSR, whose memo semantics would hide UI regressions.
describe("reactive sidebar controller", () => {
  for (const scenario of [
    "ready",
    "stale-guard",
    "disposed",
    "bounded-lookup",
    "hierarchy",
    "context",
    "options",
  ]) {
    test(scenario, () => {
      const result = Bun.spawnSync(
        [
          process.execPath,
          "--conditions=browser",
          fileURLToPath(new URL("./fixtures/ui-controller.ts", import.meta.url)),
          scenario,
        ],
        { stdout: "pipe", stderr: "pipe", timeout: 10_000 },
      );
      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout.toString())).toEqual({ scenario, passed: true });
    });
  }
});
