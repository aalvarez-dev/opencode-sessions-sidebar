/** Test-only X11 transport: stock OpenCode in xterm, real X input and window pixels. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseFontManifest, verifyFontFile } from "./font-bundle";

export interface GraphicalTerminalOptions {
  readonly executable: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  readonly cols: number;
  readonly rows: number;
  readonly theme: "dark" | "light";
  readonly directory: string;
  readonly label: string;
}

const xml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");

export async function startGraphicalTerminal(options: GraphicalTerminalOptions) {
  assert.equal(process.platform, "linux", "The graphical transport currently supports X11 Linux.");
  assert(process.env.DISPLAY, "Run the graphical probe inside an isolated Xvfb display.");
  assert(
    process.env.SIDEBAR_GRAPHICAL_FONT_FILE,
    "Set SIDEBAR_GRAPHICAL_FONT_FILE to the pinned font.",
  );
  assert(/^[a-z0-9-]+$/.test(options.label), "Use a synthetic graphical window label.");
  const fontFile = resolve(process.env.SIDEBAR_GRAPHICAL_FONT_FILE);
  const manifest = parseFontManifest(
    await readFile(new URL("../../assets/fonts/manifest.json", import.meta.url)),
  );
  const font = manifest.files[0];
  assert(font, "The pinned font manifest must contain a font.");
  const fontSha256 = font.sha256;
  verifyFontFile(font, await readFile(fontFile), true);
  const directory = resolve(options.directory);
  await mkdir(directory, { recursive: true });
  const fontConfig = join(directory, `${options.label}-fontconfig.xml`);
  await writeFile(
    fontConfig,
    `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><include ignore_missing="yes">/etc/fonts/fonts.conf</include><dir>${xml(dirname(fontFile))}</dir><cachedir>${xml(join(directory, "font-cache"))}</cachedir></fontconfig>`,
  );
  const env = {
    ...options.env,
    DISPLAY: process.env.DISPLAY,
    XAUTHORITY: process.env.XAUTHORITY,
    FONTCONFIG_FILE: fontConfig,
  };
  const run = (command: string, args: string[]) =>
    execFileSync(command, args, {
      env,
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  const resolvedFont = run("fc-match", ["--format", "%{family}\n%{file}\n", manifest.family])
    .trim()
    .split("\n");
  assert.equal(
    resolve(resolvedFont[1] ?? ""),
    fontFile,
    "xterm must resolve the pinned font file.",
  );
  const title = `sidebar-lab-${options.label}-${process.pid}`;
  let cols = options.cols;
  let rows = options.rows;
  const captures: {
    name: string;
    file: string;
    cols: number;
    rows: number;
    width: number;
    height: number;
  }[] = [];
  const child = Bun.spawn(
    [
      "setsid",
      "xterm",
      "-title",
      title,
      "-name",
      title,
      "-fa",
      manifest.family,
      "-fs",
      "13",
      "-b",
      "0",
      "-bw",
      "0",
      "+sb",
      "-xrm",
      "XTerm*internalBorder: 0",
      "-xrm",
      "XTerm*allowWindowOps: false",
      "-fg",
      options.theme === "dark" ? "white" : "black",
      "-bg",
      options.theme === "dark" ? "black" : "white",
      "-geometry",
      `${cols}x${rows}+0+0`,
      "-e",
      options.executable,
      ...(options.args ?? []),
    ],
    { cwd: options.cwd, env, stdout: "ignore", stderr: "pipe" },
  );
  let window = "";
  let closed = false;
  const errors = new Response(child.stderr).text();
  async function close() {
    if (closed) return;
    closed = true;
    // setsid owns a dedicated process group; never signal other jobs or displays.
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    await Promise.race([child.exited, Bun.sleep(1_000)]);
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
  try {
    const started = performance.now();
    while (!window) {
      assert(
        child.exitCode === null,
        `xterm exited: ${await Promise.race([errors, Promise.resolve("")])}`,
      );
      try {
        window =
          run("xdotool", ["search", "--onlyvisible", "--classname", `^${title}$`])
            .trim()
            .split("\n")[0] ?? "";
      } catch {
        /* Mapping is asynchronous. */
      }
      assert(performance.now() - started < 10_000, "xterm did not map a window.");
      if (!window) await Bun.sleep(25);
    }
    assert(/^\d+$/.test(window), "xterm must expose a numeric X11 window ID.");
    run("xdotool", ["windowfocus", "--sync", window]);
  } catch (error) {
    await close();
    throw error;
  }

  function geometry() {
    const values = Object.fromEntries(
      run("xdotool", ["getwindowgeometry", "--shell", window])
        .trim()
        .split("\n")
        .map((line) => line.split("=")),
    );
    const width = Number(values.WIDTH);
    const height = Number(values.HEIGHT);
    assert(width > 0 && height > 0, "Mapped xterm must have a visible drawable area.");
    return { width, height, cellWidth: width / cols, cellHeight: height / rows };
  }
  function input(sequence: string) {
    assert(!closed && child.exitCode === null, "Cannot input into a closed graphical terminal.");
    run("xdotool", ["windowfocus", "--sync", window]);
    while (sequence.length) {
      const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(sequence);
      if (mouse) {
        const code = Number(mouse[1]);
        const x = Number(mouse[2]);
        const y = Number(mouse[3]);
        const { cellWidth, cellHeight } = geometry();
        const position = [
          "mousemove",
          "--window",
          window,
          String(Math.floor((x - 0.5) * cellWidth)),
          String(Math.floor((y - 0.5) * cellHeight)),
        ];
        if (code === 64 || code === 65) {
          let repeats = 0;
          while (sequence.startsWith(mouse[0])) {
            repeats++;
            sequence = sequence.slice(mouse[0].length);
          }
          run("xdotool", [
            ...position,
            "click",
            "--repeat",
            String(repeats),
            "--delay",
            "1",
            String(code === 64 ? 4 : 5),
          ]);
          continue;
        }
        assert.equal(
          code,
          0,
          "The graphical fixture supports left mouse and vertical wheel input.",
        );
        run("xdotool", [...position, mouse[4] === "M" ? "mousedown" : "mouseup", "1"]);
        sequence = sequence.slice(mouse[0].length);
        continue;
      }
      const keys: [string, string][] = [
        ["\x1b[6~", "Next"],
        ["\x1b[5~", "Prior"],
        ["\x1b[A", "Up"],
        ["\x1b[B", "Down"],
        ["\x1b[C", "Right"],
        ["\x1b[D", "Left"],
        ["\x1b", "Escape"],
        ["\r", "Return"],
        ["\n", "Return"],
        ["\t", "Tab"],
        ["\x01", "ctrl+a"],
        ["\x0b", "ctrl+k"],
        ["\x10", "ctrl+p"],
      ];
      const key = keys.find(([prefix]) => sequence.startsWith(prefix));
      if (key) {
        run("xdotool", ["key", "--clearmodifiers", "--delay", "0", key[1]]);
        sequence = sequence.slice(key[0].length);
        continue;
      }
      const printable = /^[^\x00-\x1f\x7f]+/.exec(sequence)?.[0];
      assert(printable, `Unsupported graphical input code ${sequence.charCodeAt(0)}.`);
      run("xdotool", ["type", "--clearmodifiers", "--delay", "0", "--", printable]);
      sequence = sequence.slice(printable.length);
    }
  }
  function resize(nextCols: number, nextRows: number) {
    assert(
      Number.isInteger(nextCols) && nextCols > 0 && Number.isInteger(nextRows) && nextRows > 0,
    );
    run("xdotool", [
      "windowsize",
      "--sync",
      "--usehints",
      window,
      String(nextCols),
      String(nextRows),
    ]);
    cols = nextCols;
    rows = nextRows;
  }
  async function capture(name: string) {
    assert(/^[a-z0-9-]+$/.test(name), "Use a synthetic capture label.");
    // The observer assertion precedes this call. Allow X to flush the actual terminal paint.
    await Bun.sleep(100);
    const file = `${name}.png`;
    run("import", ["-silent", "-window", window, join(directory, file)]);
    const { width, height } = geometry();
    const result = { name, file, cols, rows, width, height };
    captures.push(result);
    await writeFile(
      join(directory, `${options.label}-captures.json`),
      `${JSON.stringify(metadata(), null, 2)}\n`,
    );
    return result;
  }
  function metadata() {
    return {
      transport: "xterm on X11; XTEST keyboard/mouse via xdotool",
      capture: "Actual xterm window pixels from ImageMagick import; no buffer reconstruction",
      xterm: run("xterm", ["-version"]).trim(),
      fontFamily: resolvedFont[0],
      fontFile,
      fontSha256,
      captures: [...captures],
      limitations: [
        "One fixed font and X11 terminal; this does not certify arbitrary terminal fallback or a macOS GUI.",
      ],
    };
  }
  return { process: child, input, resize, capture, close, metadata };
}

export type GraphicalTerminal = Awaited<ReturnType<typeof startGraphicalTerminal>>;
