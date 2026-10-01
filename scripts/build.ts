import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin";

const root = fileURLToPath(new URL("../", import.meta.url));
await rm(new URL("../dist/", import.meta.url), { recursive: true, force: true });

// Keep the headless development libraries separate from the rendered TUI.
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

// The stock host supplies these runtimes. A second Solid owner graph or OpenTUI
// renderer in the plugin breaks reactivity and lifecycle ownership.
const hostPackages = ["solid-js", "@opentui/core", "@opentui/solid", "@opentui/keymap"];
const tui = await Bun.build({
  entrypoints: [fileURLToPath(new URL("../src/tui.tsx", import.meta.url))],
  outdir: fileURLToPath(new URL("../dist/", import.meta.url)),
  root,
  target: "bun",
  format: "esm",
  naming: "tui.js",
  conditions: ["bun", "node"],
  plugins: [createSolidTransformPlugin()],
  external: hostPackages.flatMap((name) => [name, `${name}/*`]),
  sourcemap: "linked",
  metafile: true,
});
if (!tui.success) {
  for (const log of tui.logs) console.error(log);
  process.exitCode = 1;
} else {
  const bundled = Object.keys(tui.metafile?.inputs ?? {});
  if (
    !tui.metafile ||
    bundled.some((path) => /node_modules[/\\\\](?:solid-js|@opentui)[/\\\\]/.test(path))
  ) {
    throw new Error("The TUI build must not bundle the host's Solid/OpenTUI runtime.");
  }
  console.log("TUI build uses external host Solid/OpenTUI runtimes.");
}
