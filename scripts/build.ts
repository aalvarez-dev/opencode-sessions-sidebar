import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
await rm(new URL("../dist/", import.meta.url), { recursive: true, force: true });

// This builds the portable domain library, not an installable TUI plugin.
const result = await Bun.build({
  entrypoints: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
  outdir: fileURLToPath(new URL("../dist/", import.meta.url)),
  root,
  target: "browser",
  format: "esm",
  naming: "index.js",
  sourcemap: "linked",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exitCode = 1;
}
