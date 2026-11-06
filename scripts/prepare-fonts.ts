import { execFileSync } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  fontCodepoints,
  fontInstallPlan,
  installFontBundle,
  parseFontManifest,
  readPreparedBundle,
  verifyFontFile,
  writeFontBundle,
  type FontFile,
} from "./lib/font-bundle";

const usage = `Optional sidebar font setup (Bun 1.3.14):
  bun run fonts:prepare --download NEW_DIRECTORY
  bun run fonts:prepare --verify DIRECTORY
  bun run fonts:prepare --install DIRECTORY
  bun run fonts:prepare --install DIRECTORY --apply [--refresh-cache] [--display-machine]
  bun run fonts:prepare --config ghostty|vscode|gnome|terminal

Downloads pinned Iosevka Nerd Font Mono Regular and preserves licenses.
Checks every sidebar icon/animation and ordinary ASCII against the font's cmap
and glyph advances. Verification is offline. Font files are not modified.
--install previews the CURRENT USER destination; --apply explicitly writes it.
Run on the computer displaying the terminal, not just its SSH/Docker server.
SSH requires --display-machine to acknowledge this is also the display machine.
--refresh-cache explicitly runs fc-cache for the new Linux font directory.
Terminal configuration is never edited; --config prints setup instructions.
No arguments: show help only. See docs/terminal-fonts.md.`;

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
  verifyFontFile(file, bytes, true);
  return bytes;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || (args.length === 1 && args[0] === "--help")) {
    console.log(usage);
    return;
  }
  const [command, directory, ...flags] = args;
  if (
    !directory ||
    directory.startsWith("--") ||
    !["--download", "--verify", "--install", "--config"].includes(command ?? "") ||
    (command !== "--install" && flags.length > 0) ||
    new Set(flags).size !== flags.length ||
    flags.some((flag) => !["--apply", "--refresh-cache", "--display-machine"].includes(flag)) ||
    (flags.includes("--refresh-cache") && !flags.includes("--apply"))
  )
    throw new Error(usage);
  const source = new URL("../assets/fonts/", import.meta.url);
  const manifestBytes = await readFile(new URL("manifest.json", source));
  const manifest = parseFontManifest(manifestBytes);
  if (command === "--config") {
    const instructions: Record<string, string> = {
      ghostty: `# Add deliberately to your Ghostty profile, then open a new terminal.\nfont-family = ""\nfont-family = "${manifest.family}"\n# Keep the same family for styled text:\nfont-family-bold = "${manifest.family}"\nfont-family-italic = "${manifest.family}"\nfont-family-bold-italic = "${manifest.family}"`,
      vscode: JSON.stringify(
        { "terminal.integrated.fontFamily": `'${manifest.family}', monospace` },
        null,
        2,
      ),
      gnome: `GNOME Terminal: Preferences > your profile > Text > Custom font.\nSelect "${manifest.family}" (possibly "${manifest.legacyFamily}").\nKeep your preferred font size. Open a new terminal and run the sidebar icon check.`,
      terminal: `macOS Terminal: Settings > Profiles > Text > Font > Change.\nSelect "${manifest.family}" (possibly "${manifest.legacyFamily}").\nApply to the profile you use and open a new terminal.\nIf macOS has not registered the files, open the prepared .ttf in Font Book and install for your user.`,
    };
    const output = instructions[directory];
    if (!output) throw new Error(usage);
    console.log(output);
    return;
  }
  const destination = resolve(directory);
  if (command === "--verify" || command === "--install") {
    const files = await readPreparedBundle(destination, manifest, manifestBytes);
    console.log(
      `Verified pinned bytes and ${fontCodepoints().length} required codepoints in ${manifest.family}.`,
    );
    if (command === "--verify") return;
    const apply = flags.includes("--apply");
    if (apply && (process.env.SUDO_USER || process.getuid?.() === 0))
      throw new Error("Run font installation as your ordinary desktop user, without sudo/root.");
    if (flags.includes("--refresh-cache") && process.platform !== "linux")
      throw new Error("--refresh-cache is only available on Linux.");
    if (
      process.platform === "linux" &&
      process.env.XDG_DATA_HOME &&
      resolve(process.env.XDG_DATA_HOME) !== resolve(homedir(), ".local", "share")
    )
      throw new Error(
        "Custom XDG_DATA_HOME detected. Install the verified files through your desktop font manager; automatic placement uses the standard user font directory.",
      );
    const plan = fontInstallPlan({
      platform: process.platform,
      home: homedir(),
      bundleId: manifest.id,
      ssh: Boolean(process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY),
      displayMachine: flags.includes("--display-machine"),
    });
    const status = await installFontBundle(plan, manifest, manifestBytes, files, apply);
    console.log(`${status}: ${plan.destination}`);
    if (flags.includes("--refresh-cache")) {
      try {
        execFileSync("fc-cache", ["-f", plan.destination], { timeout: 15_000, stdio: "pipe" });
      } catch {
        throw new Error(
          "Fonts remain installed, but fc-cache failed or is unavailable. Refresh them with your desktop font manager; do not reinstall with sudo.",
        );
      }
      console.log("Refreshed the Linux cache for this directory.");
    }
    console.log(
      apply
        ? "No terminal settings changed. Select this font and run Sessions sidebar: check icons."
        : "Dry run: no files or terminal settings changed. Add --apply to install for this user.",
    );
    return;
  }
  try {
    await lstat(destination);
    throw new Error("Destination already exists. Use --verify or choose a new directory.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const files = new Map<string, Uint8Array>();
  for (const license of manifest.licenses) {
    const bytes = await readFile(new URL(`licenses/${license.name}`, source));
    verifyFontFile(license, bytes);
    files.set(license.name, bytes);
  }
  for (const file of manifest.files) files.set(file.name, await download(file, manifest.commit));
  files.set("manifest.json", manifestBytes);
  await writeFontBundle(destination, files);
  console.log(
    `Prepared ${manifest.family} with complete sidebar glyph coverage in ${destination}.`,
  );
  console.log("No fonts installed. Run --install DIRECTORY to preview current-user placement.");
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
