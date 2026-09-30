import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
await rm(new URL("../dist/", import.meta.url), { recursive: true, force: true });

// Separate development libraries; neither entrypoint installs or renders a TUI.
// The adapter uses host types only. It must not bundle a host/UI runtime.
for (const [source, destination] of [
  ["../src/index.ts", "../dist/"],
  ["../src/adapters/opencode-v1/index.ts", "../dist/adapters/opencode-v1/"],
] as const) {
  const result = await Bun.build({
    entrypoints: [fileURLToPath(new URL(source, import.meta.url))],
    outdir: fileURLToPath(new URL(destination, import.meta.url)),
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
}
