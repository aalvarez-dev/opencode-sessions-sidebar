import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("native labels appear, react and preserve graphemes across terminal resizes", () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      "--conditions=browser",
      "--preload",
      "@opentui/solid/preload",
      fileURLToPath(new URL("./fixtures/ui-label.ts", import.meta.url)),
    ],
    { stdout: "pipe", stderr: "pipe", timeout: 10_000 },
  );
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toEqual({
    scope: "native-opentui-label",
    passed: true,
  });
});
