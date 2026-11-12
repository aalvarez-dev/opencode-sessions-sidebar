import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertFontCoverage, inspectFontCoverage } from "../scripts/lib/font-coverage";
import {
  digest,
  fontCodepoints,
  fontInstallPlan,
  installFontBundle,
  parseFontManifest,
  readPreparedBundle,
  verifyFontFile,
  writeFontBundle,
  type FontManifest,
} from "../scripts/lib/font-bundle";

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function temporary() {
  const result = await mkdtemp(join(tmpdir(), "sidebar-font-test-"));
  folders.push(result);
  return result;
}

/** Minimal sfnt fixture: real cmap 4/12 and hmtx semantics, no drawable font outlines. */
function fontFixture(
  points = fontCodepoints(),
  format = 12,
  wrongWidth?: number,
  outlines?: { format: 0 | 1; bounds?: ReadonlyMap<number, readonly [number, number]> },
) {
  const cps = [...new Set(points)].sort((a, b) => a - b);
  const segments = cps.length + 1;
  const sub = Buffer.alloc(
    format === 12 ? 16 + cps.length * 12 : 16 + segments * 8 + cps.length * 2,
  );
  sub.writeUInt16BE(format, 0);
  if (format === 12) {
    sub.writeUInt32BE(sub.length, 4);
    sub.writeUInt32BE(cps.length, 12);
    cps.forEach((cp, i) => {
      const at = 16 + i * 12;
      sub.writeUInt32BE(cp, at);
      sub.writeUInt32BE(cp, at + 4);
      sub.writeUInt32BE(i + 1, at + 8);
    });
  } else {
    sub.writeUInt16BE(sub.length, 2);
    sub.writeUInt16BE(segments * 2, 6);
    const ends = 14,
      starts = ends + segments * 2 + 2,
      deltas = starts + segments * 2,
      offsets = deltas + segments * 2,
      glyphs = offsets + segments * 2;
    cps.forEach((cp, i) => {
      sub.writeUInt16BE(cp, ends + i * 2);
      sub.writeUInt16BE(cp, starts + i * 2);
      sub.writeUInt16BE(glyphs + i * 2 - (offsets + i * 2), offsets + i * 2);
      sub.writeUInt16BE(i + 1, glyphs + i * 2);
    });
    sub.writeUInt16BE(0xffff, ends + cps.length * 2);
    sub.writeUInt16BE(0xffff, starts + cps.length * 2);
    sub.writeUInt16BE(1, deltas + cps.length * 2);
  }
  const cmap = Buffer.alloc(12 + sub.length);
  cmap.writeUInt16BE(1, 2);
  cmap.writeUInt16BE(3, 4);
  cmap.writeUInt16BE(format === 12 ? 10 : 1, 6);
  cmap.writeUInt32BE(12, 8);
  sub.copy(cmap, 12);
  const hhea = Buffer.alloc(36);
  hhea.writeUInt16BE(cps.length + 1, 34);
  const hmtx = Buffer.alloc((cps.length + 1) * 4);
  cps.forEach((cp, i) => hmtx.writeUInt16BE(cp === wrongWidth ? 1000 : 500, (i + 1) * 4));
  const maxp = Buffer.alloc(6);
  maxp.writeUInt16BE(cps.length + 1, 4);
  const tables: Record<string, Buffer> = { cmap, hhea, hmtx, maxp };
  if (outlines) {
    const head = Buffer.alloc(54),
      glyf = Buffer.alloc((cps.length + 1) * 10),
      loca = Buffer.alloc((cps.length + 2) * (outlines.format === 0 ? 2 : 4));
    head.writeInt16BE(outlines.format, 50);
    for (let i = 0; i <= cps.length + 1; i++) {
      if (outlines.format === 0) loca.writeUInt16BE(i * 5, i * 2);
      else loca.writeUInt32BE(i * 10, i * 4);
    }
    cps.forEach((cp, i) => {
      const at = (i + 1) * 10,
        [min, max] = outlines.bounds?.get(cp) ?? [0, 500];
      glyf.writeInt16BE(min, at + 2);
      glyf.writeInt16BE(max, at + 6);
      glyf.writeInt16BE(600, at + 8);
    });
    Object.assign(tables, { head, loca, glyf });
  }
  const result = Buffer.alloc(
    12 +
      Object.keys(tables).length * 16 +
      Object.values(tables).reduce((sum, value) => sum + value.length, 0),
  );
  result.writeUInt32BE(0x00010000, 0);
  result.writeUInt16BE(Object.keys(tables).length, 4);
  let offset = 12 + Object.keys(tables).length * 16;
  Object.entries(tables).forEach(([name, bytes], i) => {
    const at = 12 + i * 16;
    result.write(name, at, "ascii");
    result.writeUInt32BE(offset, at + 8);
    result.writeUInt32BE(bytes.length, at + 12);
    bytes.copy(result, offset);
    offset += bytes.length;
  });
  return result;
}

function bundle() {
  const font = fontFixture(undefined, 12, undefined, { format: 1 }),
    license = Buffer.from("Synthetic test license\n");
  const manifest: FontManifest = {
    id: "synthetic-font-v1",
    family: "Synthetic Mono",
    legacyFamily: "Synthetic Mono",
    baseVersion: "1",
    nerdFontsVersion: "1",
    commit: "1".repeat(40),
    files: [
      {
        name: "Synthetic.ttf",
        path: "fonts/Synthetic.ttf",
        bytes: font.length,
        sha256: digest(font),
      },
    ],
    licenses: [
      { name: "LICENSE.txt", path: "LICENSE.txt", bytes: license.length, sha256: digest(license) },
    ],
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const files = new Map<string, Uint8Array>([
    ["Synthetic.ttf", font],
    ["LICENSE.txt", license],
    ["manifest.json", manifestBytes],
  ]);
  return { manifest, manifestBytes, files };
}

describe("portable font coverage", () => {
  test("checks both Unicode cmap formats, including offset glyph arrays and animation symbols", () => {
    for (const format of [4, 12]) {
      // Format 4 only represents the BMP; Material controls require full Unicode format 12.
      const points = fontCodepoints().filter((cp) => format === 12 || cp <= 0xffff);
      const font = fontFixture(points, format);
      expect(inspectFontCoverage(font, points)).toEqual({
        cellAdvance: 500,
        missing: [],
        differentAdvance: [],
      });
      if (format === 4)
        expect(inspectFontCoverage(font, fontCodepoints()).missing).toEqual(
          fontCodepoints().filter((cp) => cp > 0xffff),
        );
    }
    expect(fontCodepoints()).toContain(0x21bb);
    expect(fontCodepoints()).toContain(0x280b);
    expect(fontCodepoints()).toContain(0xf0403);
  });
  test("rejects missing icons and different advances despite valid font structure", () => {
    expect(() =>
      assertFontCoverage(
        fontFixture(fontCodepoints().filter((cp) => cp !== 0x21bb)),
        fontCodepoints(),
      ),
    ).toThrow("U+21BB");
    expect(() =>
      assertFontCoverage(fontFixture(fontCodepoints(), 12, 0x280b), fontCodepoints()),
    ).toThrow("inconsistent glyph advances");
  });
  test("outline checks catch clipping despite equal advances in both loca formats", () => {
    const points = [0x4d, 0x2026, 0xeab2];
    for (const format of [0, 1] as const) {
      const font = fontFixture(points, 12, undefined, {
        format,
        bounds: new Map([
          [0x2026, [89, 911] as const],
          [0xeab2, [0, 500] as const],
        ]),
      });
      expect(inspectFontCoverage(font, points).differentAdvance).toEqual([]);
      expect(inspectFontCoverage(font, points, [0xeab2]).outsideCell).toEqual([]);
      expect(inspectFontCoverage(font, points, [0x2026]).outsideCell).toEqual([0x2026]);
      expect(() => assertFontCoverage(font, points, [0x2026])).toThrow("U+2026");
      const leftOverflow = fontFixture(points, 12, undefined, {
        format,
        bounds: new Map([[0xeab2, [-1, 499] as const]]),
      });
      expect(() => assertFontCoverage(leftOverflow, points, [0xeab2])).toThrow("U+EAB2");
    }
    // Coverage-only callers still accept fonts whose outline tables are not requested.
    expect(() => assertFontCoverage(fontFixture(points), points)).not.toThrow();
    expect(() => assertFontCoverage(fontFixture(points), points, [0xeab2])).toThrow("head");
  });
  test("bounds malformed outline tables and explicit outline requests", () => {
    const points = [0x4d, 0xeab2];
    const sample = () => fontFixture(points, 12, undefined, { format: 1 });
    const tableStart = (font: Buffer, name: string) => {
      for (let i = 0; i < font.readUInt16BE(4); i++) {
        const at = 12 + i * 16;
        if (font.toString("ascii", at, at + 4) === name) return font.readUInt32BE(at + 8);
      }
      throw new Error(`Missing fixture table ${name}`);
    };
    const locaFormat = sample();
    locaFormat.writeInt16BE(2, tableStart(locaFormat, "head") + 50);
    expect(() => inspectFontCoverage(locaFormat, points, points)).toThrow("loca format");
    const offsets = sample();
    offsets.writeUInt32BE(0xffffffff, tableStart(offsets, "loca") + 8);
    expect(() => inspectFontCoverage(offsets, points, points)).toThrow("glyph offsets");
    const shortGlyph = sample();
    shortGlyph.writeUInt32BE(25, tableStart(shortGlyph, "loca") + 8);
    expect(() => inspectFontCoverage(shortGlyph, points, points)).toThrow("Truncated");
    const inverted = sample();
    inverted.writeInt16BE(501, tableStart(inverted, "glyf") + 20 + 2);
    expect(() => inspectFontCoverage(inverted, points, points)).toThrow("glyph bounds");
    expect(() => inspectFontCoverage(sample(), points, [NaN])).toThrow("request");
    expect(() => inspectFontCoverage(sample(), points, [0xffff])).toThrow("Missing outline");
  });
  test("pinned-file verification rejects Nerd overhang even when the hash and advances match", () => {
    const check = (bounds: ReadonlyMap<number, readonly [number, number]>) => {
      const font = fontFixture(undefined, 12, undefined, { format: 1, bounds });
      verifyFontFile(
        { name: "synthetic.ttf", path: "synthetic.ttf", bytes: font.length, sha256: digest(font) },
        font,
        true,
      );
    };
    // Unicode compatibility glyphs can overhang; the fitted guarantee is Nerd-only.
    expect(() => check(new Map([[0x2026, [89, 911] as const]]))).not.toThrow();
    expect(() => check(new Map([[0xea7c, [89, 911] as const]]))).toThrow("U+EA7C");
    expect(() => check(new Map([[0xf0931, [-1, 500] as const]]))).toThrow("U+F0931");
  });
  test("bounds malformed directories, tables, cmaps, and caller requests", () => {
    const directory = fontFixture();
    directory.writeUInt32BE(0xffffff00, 20);
    expect(() => inspectFontCoverage(directory, [77])).toThrow();
    expect(() => inspectFontCoverage(fontFixture().subarray(0, 100), [77])).toThrow();
    const groups = fontFixture();
    groups.writeUInt32BE(0xffffffff, 76 + 12 + 12);
    expect(() => inspectFontCoverage(groups, [77])).toThrow();
    expect(() => inspectFontCoverage(fontFixture(), [NaN])).toThrow();
  });
  test("manifest rejects path traversal, coercible IDs, duplicate names, and oversized entries", () => {
    const { manifest } = bundle();
    const parse = (value: unknown) => parseFontManifest(Buffer.from(JSON.stringify(value)));
    expect(parse(manifest)).toEqual(manifest);
    expect(() => parse({ ...manifest, id: undefined })).toThrow();
    expect(() =>
      parse({ ...manifest, files: [{ ...manifest.files[0], name: "../escape.ttf" }] }),
    ).toThrow();
    expect(() => parse({ ...manifest, licenses: manifest.files })).toThrow();
    expect(() =>
      parse({ ...manifest, files: [{ ...manifest.files[0], bytes: 100_000_000 }] }),
    ).toThrow();
  });
});

describe("explicit current-user font placement", () => {
  test("requires SSH display acknowledgment and distinguishes Ubuntu/macOS destinations", async () => {
    const home = await temporary();
    expect(() =>
      fontInstallPlan({
        home,
        platform: "linux",
        bundleId: "test",
        ssh: true,
        displayMachine: false,
      }),
    ).toThrow("SSH detected");
    expect(
      fontInstallPlan({
        home,
        platform: "linux",
        bundleId: "test",
        ssh: true,
        displayMachine: true,
      }).destination,
    ).toBe(join(home, ".local/share/fonts/opencode-sessions-sidebar/test"));
    expect(
      fontInstallPlan({
        home,
        platform: "darwin",
        bundleId: "test",
        ssh: false,
        displayMachine: false,
      }).destination,
    ).toBe(join(home, "Library/Fonts/opencode-sessions-sidebar/test"));
    expect(() =>
      fontInstallPlan({
        home,
        platform: "win32",
        bundleId: "test",
        ssh: false,
        displayMachine: false,
      }),
    ).toThrow();
  });
  test("dry-run writes nothing; apply preserves verified bytes/licenses and is repeatable", async () => {
    const home = await temporary(),
      b = bundle();
    const plan = fontInstallPlan({
      home,
      platform: "linux",
      bundleId: b.manifest.id,
      ssh: false,
      displayMachine: false,
    });
    expect(await installFontBundle(plan, b.manifest, b.manifestBytes, b.files)).toBe("planned");
    expect(await readdir(home)).toEqual([]);
    expect(await installFontBundle(plan, b.manifest, b.manifestBytes, b.files, true)).toBe(
      "installed",
    );
    expect(await readPreparedBundle(plan.destination, b.manifest, b.manifestBytes)).toEqual(
      b.files,
    );
    const receipt = JSON.parse(
      await readFile(join(plan.destination, "installation-receipt.json"), "utf8"),
    );
    expect(receipt.terminalConfigurationChanged).toBe(false);
    expect(await installFontBundle(plan, b.manifest, b.manifestBytes, b.files, true)).toBe(
      "already-installed",
    );
    await writeFile(join(plan.destination, "Synthetic.ttf"), "foreign");
    await expect(
      installFontBundle(plan, b.manifest, b.manifestBytes, b.files, true),
    ).rejects.toThrow("Invalid prepared file");
    expect(await readFile(join(plan.destination, "Synthetic.ttf"), "utf8")).toBe("foreign");
  });
  test("rejects tampered bundles before creating directories", async () => {
    const home = await temporary(),
      b = bundle();
    const plan = fontInstallPlan({
      home,
      platform: "darwin",
      bundleId: b.manifest.id,
      ssh: false,
      displayMachine: false,
    });
    b.files.set("Synthetic.ttf", Buffer.from("unverified"));
    await expect(
      installFontBundle(plan, b.manifest, b.manifestBytes, b.files, true),
    ).rejects.toThrow("Integrity check");
    expect(await readdir(home)).toEqual([]);
  });
  test.skipIf(process.platform === "win32")(
    "does not follow destination symlinks or accept partial previous installations",
    async () => {
      const home = await temporary(),
        outside = await temporary(),
        b = bundle();
      const plan = fontInstallPlan({
        home,
        platform: "linux",
        bundleId: b.manifest.id,
        ssh: false,
        displayMachine: false,
      });
      await symlink(outside, join(home, ".local"), "dir");
      await expect(
        installFontBundle(plan, b.manifest, b.manifestBytes, b.files, true),
      ).rejects.toThrow("symbolic-link");
      expect(await readdir(outside)).toEqual([]);
      await rm(join(home, ".local"));
      await mkdir(plan.destination, { recursive: true });
      await expect(installFontBundle(plan, b.manifest, b.manifestBytes, b.files)).rejects.toThrow();
      expect(await readdir(plan.destination)).toEqual([]);
    },
  );
  test.skipIf(process.platform === "win32")(
    "bundle reader refuses symlinked entries and a different prepared manifest",
    async () => {
      const root = await temporary(),
        b = bundle(),
        dir = join(root, "bundle");
      await writeFontBundle(dir, b.files);
      await writeFile(join(dir, "manifest.json"), Buffer.from("{}"));
      await expect(readPreparedBundle(dir, b.manifest, b.manifestBytes)).rejects.toThrow(
        "manifest.json",
      );
      await writeFile(join(dir, "manifest.json"), b.manifestBytes);
      await writeFile(join(root, "foreign.ttf"), b.files.get("Synthetic.ttf")!);
      await rm(join(dir, "Synthetic.ttf"));
      await symlink(join(root, "foreign.ttf"), join(dir, "Synthetic.ttf"));
      await expect(readPreparedBundle(dir, b.manifest, b.manifestBytes)).rejects.toThrow(
        "Synthetic.ttf",
      );
    },
  );
});
