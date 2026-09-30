import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
await rm(new URL("../dist/", import.meta.url), { recursive: true, force: true });

// Separate development libraries; none installs or renders a TUI.
// Filesystem access stays in its own Node-compatible entrypoint.
for (const [source, destination, target, naming] of [
  ["../src/index.ts", "../dist/", "browser", "index.js"],
  ["../src/adapters/opencode-v1/index.ts", "../dist/adapters/opencode-v1/", "browser", "index.js"],
  ["../src/organization/index.ts", "../dist/organization/", "browser", "index.js"],
  ["../src/storage/file.ts", "../dist/storage/", "node", "file.js"],
] as const) {
  const result = await Bun.build({
    entrypoints: [fileURLToPath(new URL(source, import.meta.url))],
    outdir: fileURLToPath(new URL(destination, import.meta.url)),
    root,
    target,
    format: "esm",
    naming,
    sourcemap: "linked",
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exitCode = 1;
  }
}
