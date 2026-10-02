import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

interface FontFile {
  name: string;
  path: string;
  sha256: string;
  bytes: number;
}

interface FontManifest {
  family: string;
  nerdFontsVersion: string;
  commit: string;
  files: FontFile[];
  licenses: FontFile[];
}

const usage = `Optional font preparation (Bun 1.3.14):
  bun run fonts:prepare --download NEW_DIRECTORY
  bun run fonts:prepare --verify DIRECTORY

Downloads the pinned JetBrainsMono Nerd Font Mono files and preserves licenses.
The destination's parent must exist; an existing destination is never replaced.
This command does not install fonts or change terminal settings. Install the
prepared fonts manually on the computer displaying the terminal, if desired.
See docs/terminal-fonts.md. With no arguments, only this help is printed.`;

function verifyBytes(file: FontFile, bytes: Uint8Array): void {
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== file.bytes || hash !== file.sha256) {
    throw new Error(`Integrity check failed for ${file.name}. No unverified font will be written.`);
  }
}

async function download(file: FontFile, commit: string): Promise<Uint8Array> {
  const response = await fetch(
    `https://raw.githubusercontent.com/ryanoasis/nerd-fonts/${commit}/${file.path}`,
    { redirect: "error", signal: AbortSignal.timeout(30_000) },
  );
  if (!response.ok || !response.body) throw new Error(`Download failed: ${file.name}.`);
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > file.bytes) throw new Error(`Unexpected download size: ${file.name}.`);
      parts.push(chunk.value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = Buffer.concat(parts);
  verifyBytes(file, bytes);
  return bytes;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || (args.length === 1 && args[0] === "--help")) {
    console.log(usage);
    return;
  }
  const [command, directory] = args;
  if (
    args.length !== 2 ||
    !directory ||
    directory.startsWith("--") ||
    !["--download", "--verify"].includes(command ?? "")
  ) {
    throw new Error(usage);
  }
  const destination = resolve(directory);
  const source = new URL("../assets/fonts/", import.meta.url);
  const manifestBytes = await readFile(new URL("manifest.json", source));
  const manifest: FontManifest = JSON.parse(manifestBytes.toString("utf8"));
  const entries = [...manifest.files, ...manifest.licenses];

  if (command === "--verify") {
    for (const entry of entries) {
      verifyBytes(entry, await readFile(join(destination, entry.name)));
    }
    console.log(`Verified ${entries.length} pinned files in ${destination}.`);
    return;
  }

  try {
    await lstat(destination);
    throw new Error(`Destination already exists: ${destination}. Use --verify or a new directory.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const prepared = new Map<string, Uint8Array>();
  for (const license of manifest.licenses) {
    const bytes = await readFile(new URL(`licenses/${license.name}`, source));
    verifyBytes(license, bytes);
    prepared.set(license.name, bytes);
  }
  for (const file of manifest.files) {
    prepared.set(file.name, await download(file, manifest.commit));
  }

  // All network responses and license bytes are verified before creating the destination.
  // Exclusive creation also rejects a destination created while downloading.
  await mkdir(destination);
  for (const [name, bytes] of prepared) {
    await writeFile(join(destination, name), bytes, { flag: "wx" });
  }
  await writeFile(join(destination, "manifest.json"), manifestBytes, { flag: "wx" });
  console.log(
    `Prepared ${manifest.family} (Nerd Fonts ${manifest.nerdFontsVersion}) in ${destination}.`,
  );
  console.log("No fonts were installed. Follow docs/terminal-fonts.md to install and select them.");
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
