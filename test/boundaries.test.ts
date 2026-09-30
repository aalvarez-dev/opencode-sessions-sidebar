import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkCoreBoundaries } from "../scripts/check-boundaries";

const temporaryRoots: string[] = [];
const script = fileURLToPath(new URL("../scripts/check-boundaries.ts", import.meta.url));

async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "sidebar-boundaries-"));
  temporaryRoots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }
  return root;
}

async function runChecker(root: string) {
  const child = Bun.spawn([process.execPath, script, root], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("core boundary gate", () => {
  test("accepts nested internal modules and succeeds through the CLI", async () => {
    const root = await fixture({
      "types.ts": "export type Value = number;",
      "nested/value.ts": 'import type { Value } from "../types"; export const value: Value = 1;',
      "index.ts":
        'export { value } from "./nested/value"; export type T = import("./types").Value;',
    });
    const result = await runChecker(root);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("(3 files)");
    expect(result.stderr).toBe("");
  });

  test("rejects dependencies and path escapes with a failing CLI exit code", async () => {
    const root = await fixture({
      "external.ts": 'import { readFile } from "node:fs/promises";',
      "exports.ts": 'export * from "../adapter";',
      "nested/escape.ts": 'import value from "../../core-neighbor/value";',
      "types.ts": 'export type T = import("host-package").Client;',
      "dotted.ts": 'import value from ".external-package";',
    });
    const result = await runChecker(root);
    expect(result.exitCode).not.toBe(0);
    for (const name of ["external.ts", "exports.ts", "escape.ts", "types.ts", "dotted.ts"]) {
      expect(result.stderr).toContain(`${name}:1:`);
    }
  });

  test("rejects require, import assignments, and dynamic loading even for local files", async () => {
    const root = await fixture({
      "require.ts": 'const fs = require("node:fs");',
      "assignment.ts": 'import fs = require("node:fs");',
      "dynamic.ts": 'const core = import("./value");',
    });
    const result = await checkCoreBoundaries(root);
    expect(result.checked).toBe(3);
    expect(result.violations).toHaveLength(3);
    expect(result.violations.some((item) => item.startsWith("require.ts:1:"))).toBe(true);
  });

  test("rejects common clock and randomness reads, including captured method references", async () => {
    const root = await fixture({
      "clock.ts": "const now = Date.now();",
      "date.ts": "const now = new Date();",
      "string-date.ts": "const now = Date();",
      "random.ts": "const random = Math.random;",
      "global.ts": 'const now = globalThis["Date"]["now"]();',
      "brackets.ts": 'const value = Math["random"]();',
    });
    const result = await checkCoreBoundaries(root);
    expect(result.violations).toHaveLength(6);
  });

  test("does not flag deterministic dates, strings, comments, or arithmetic", async () => {
    const root = await fixture({
      "value.ts": `// Date.now() and Math.random() are disallowed.
export const label = "Date.now()";
export const year = new Date(0).getUTCFullYear();
export const maximum = Math.max(1, 2);`,
    });
    expect((await checkCoreBoundaries(root)).violations).toEqual([]);
  });

  test("an empty source tree fails instead of reporting a successful check", async () => {
    const root = await fixture({ "README.md": "No source files here." });
    const result = await runChecker(root);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("No core source files were checked.");
  });
});
