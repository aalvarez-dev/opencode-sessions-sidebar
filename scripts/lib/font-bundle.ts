import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { iconCodepoints } from "../../src/ui/icons";
import { assertFontCoverage } from "./font-coverage";

export interface FontFile {
  name: string;
  path: string;
  sha256: string;
  bytes: number;
}
export interface FontManifest {
  id: string;
  family: string;
  legacyFamily: string;
  baseVersion: string;
  nerdFontsVersion: string;
  commit: string;
  files: FontFile[];
  licenses: FontFile[];
}
export const fontCodepoints = () =>
  [
    ...new Set([
      ...Array.from({ length: 95 }, (_, i) => i + 32),
      ...iconCodepoints(),
      ...Array.from("—‘’“”", (value) => value.codePointAt(0)!),
    ]),
  ].sort((a, b) => a - b);
export const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function parseFontManifest(bytes: Uint8Array): FontManifest {
  if (bytes.length > 16_384) throw new Error("Font manifest exceeds its size limit.");
  const value = JSON.parse(Buffer.from(bytes).toString("utf8")) as FontManifest;
  if (
    !value ||
    typeof value.id !== "string" ||
    !/^[a-z0-9-]{1,80}$/.test(value.id) ||
    typeof value.commit !== "string" ||
    !/^[0-9a-f]{40}$/.test(value.commit) ||
    typeof value.family !== "string" ||
    !/^[A-Za-z0-9 -]{1,80}$/.test(value.family) ||
    typeof value.legacyFamily !== "string" ||
    !/^[A-Za-z0-9 -]{1,80}$/.test(value.legacyFamily) ||
    !Array.isArray(value.files) ||
    value.files.length < 1 ||
    value.files.length > 4 ||
    !Array.isArray(value.licenses) ||
    value.licenses.length < 1 ||
    value.licenses.length > 8
  )
    throw new Error("Invalid font manifest.");
  const names = new Set<string>(["manifest.json", "installation-receipt.json"]);
  for (const file of [...value.files, ...value.licenses]) {
    if (
      !file ||
      typeof file.name !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}$/.test(file.name) ||
      names.has(file.name) ||
      typeof file.path !== "string" ||
      file.path.length > 300 ||
      file.path.split("/").some((part) => !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(part)) ||
      typeof file.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(file.sha256) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 1 ||
      file.bytes > 20 * 1024 * 1024
    )
      throw new Error("Invalid font manifest entry.");
    names.add(file.name);
  }
  return value;
}

export function verifyFontFile(file: FontFile, bytes: Uint8Array, font = false): void {
  if (bytes.length !== file.bytes || digest(bytes) !== file.sha256)
    throw new Error(`Integrity check failed for ${file.name}.`);
  if (font) assertFontCoverage(bytes, fontCodepoints(), iconCodepoints("nerd"));
}

/** Read exactly the expected size; symlinks and unbounded file growth are rejected. */
async function readPinnedFile(path: string, file: FontFile): Promise<Uint8Array> {
  const state = await lstat(path);
  if (!state.isFile() || state.size !== file.bytes)
    throw new Error(`Invalid prepared file: ${file.name}.`);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const actual = await handle.stat();
    if (!actual.isFile() || actual.size !== file.bytes)
      throw new Error(`Changed prepared file: ${file.name}.`);
    const bytes = Buffer.alloc(file.bytes);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) throw new Error(`Truncated prepared file: ${file.name}.`);
      offset += result.bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, bytes.length)).bytesRead)
      throw new Error(`Growing prepared file: ${file.name}.`);
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function readPreparedBundle(
  directory: string,
  manifest: FontManifest,
  manifestBytes: Uint8Array,
) {
  const state = await lstat(directory);
  if (!state.isDirectory() || state.isSymbolicLink())
    throw new Error("The prepared bundle must be an ordinary directory.");
  const files = new Map<string, Uint8Array>();
  for (const entry of [...manifest.files, ...manifest.licenses]) {
    const bytes = await readPinnedFile(join(directory, entry.name), entry);
    verifyFontFile(entry, bytes, manifest.files.includes(entry));
    files.set(entry.name, bytes);
  }
  const expected = {
    name: "manifest.json",
    path: "manifest.json",
    bytes: manifestBytes.length,
    sha256: digest(manifestBytes),
  };
  const saved = await readPinnedFile(join(directory, expected.name), expected);
  verifyFontFile(expected, saved);
  files.set("manifest.json", manifestBytes);
  return files;
}

export async function writeFontBundle(
  directory: string,
  files: ReadonlyMap<string, Uint8Array>,
): Promise<void> {
  if ([...files.keys()].some((name) => !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}$/.test(name)))
    throw new Error("Invalid bundle filename.");
  await mkdir(directory); // Exclusive directory creation prevents replacing an existing bundle.
  for (const [name, bytes] of files) await writeFile(join(directory, name), bytes, { flag: "wx" });
}

export function fontInstallPlan(options: {
  platform: string;
  home: string;
  bundleId: string;
  ssh: boolean;
  displayMachine: boolean;
}) {
  if (!["darwin", "linux"].includes(options.platform))
    throw new Error("Automatic font placement supports Ubuntu/Linux and macOS only.");
  if (!isAbsolute(options.home) || !/^[a-z0-9-]{1,80}$/.test(options.bundleId))
    throw new Error("Invalid user font location.");
  if (options.ssh && !options.displayMachine)
    throw new Error(
      "SSH detected: run font setup on the computer displaying the terminal. Use --display-machine only if this computer also displays it.",
    );
  const home = resolve(options.home);
  const root =
    options.platform === "darwin"
      ? join(home, "Library", "Fonts")
      : join(home, ".local", "share", "fonts");
  return {
    home,
    root,
    destination: join(root, "opencode-sessions-sidebar", options.bundleId),
    platform: options.platform,
  };
}

export type FontInstallPlan = ReturnType<typeof fontInstallPlan>;

async function checkParents(plan: FontInstallPlan, create: boolean) {
  const parts = relative(plan.home, plan.destination).split(sep).slice(0, -1);
  if (parts.some((part) => !part || part === "..")) throw new Error("Invalid font destination.");
  let current = plan.home;
  for (const part of parts) {
    current = join(current, part);
    if (create) {
      try {
        await mkdir(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    let state;
    try {
      state = await lstat(current);
    } catch (error) {
      if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!state.isDirectory() || state.isSymbolicLink())
      throw new Error("Font installation refuses symbolic-link directories.");
  }
}

export async function installFontBundle(
  plan: FontInstallPlan,
  manifest: FontManifest,
  manifestBytes: Uint8Array,
  files: ReadonlyMap<string, Uint8Array>,
  apply = false,
): Promise<"planned" | "installed" | "already-installed"> {
  // Verify the exact in-memory bytes again before touching a user font directory.
  for (const entry of [...manifest.files, ...manifest.licenses]) {
    const bytes = files.get(entry.name);
    if (!bytes) throw new Error(`Missing prepared file: ${entry.name}.`);
    verifyFontFile(entry, bytes, manifest.files.includes(entry));
  }
  const actualManifest = files.get("manifest.json");
  if (!actualManifest || digest(actualManifest) !== digest(manifestBytes))
    throw new Error("Prepared manifest mismatch.");
  await checkParents(plan, false);
  let exists = false;
  try {
    await lstat(plan.destination);
    exists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (exists) {
    await readPreparedBundle(plan.destination, manifest, manifestBytes);
    return "already-installed";
  }
  if (!apply) return "planned";
  await checkParents(plan, true);
  const output = new Map<string, Uint8Array>();
  for (const entry of [...manifest.files, ...manifest.licenses])
    output.set(entry.name, files.get(entry.name)!);
  output.set("manifest.json", manifestBytes);
  output.set(
    "installation-receipt.json",
    Buffer.from(
      JSON.stringify(
        {
          version: 1,
          bundle: manifest.id,
          platform: plan.platform,
          manifestSha256: digest(manifestBytes),
          files: [...manifest.files, ...manifest.licenses].map(({ name, sha256 }) => ({
            name,
            sha256,
          })),
          terminalConfigurationChanged: false,
        },
        null,
        2,
      ) + "\n",
    ),
  );
  await writeFontBundle(plan.destination, output);
  return "installed";
}
