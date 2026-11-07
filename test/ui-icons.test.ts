import { describe, expect, test } from "bun:test";
import {
  iconAnimations,
  iconCatalog,
  iconCodepoints,
  iconGlyph,
  iconModes,
  iconProofRows,
} from "../src/ui/icons";

describe("portable icon catalog", () => {
  test("declares terminal-cell geometry for every glyph and every animation frame", () => {
    for (const mode of iconModes) {
      for (const item of Object.values(iconCatalog)) {
        expect(item[mode].cells).toBeGreaterThan(0);
        expect(item[mode].cells).toBeLessThanOrEqual(3);
        expect(Bun.stringWidth(item[mode].text)).toBe(item[mode].cells);
      }
      for (const item of Object.values(iconAnimations)) {
        expect(item[mode].frames.length).toBeGreaterThan(0);
        for (const frame of item[mode].frames)
          expect(Bun.stringWidth(frame)).toBe(item[mode].cells);
      }
    }
    // The Unicode hourglass may use emoji presentation; it must not be declared single-cell.
    expect(iconCatalog.laterActive.unicode.cells).toBe(2);
    expect(iconCatalog.laterActive.nerd.cells).toBe(1);
  });

  test("the fallback uses printable ASCII including all motion frames", () => {
    const points = iconCodepoints("ascii");
    expect(points.length).toBeGreaterThan(0);
    expect(points.every((point) => point >= 0x20 && point <= 0x7e)).toBe(true);
    expect(iconGlyph("pinActive", "ascii")).not.toBe(iconGlyph("pinInactive", "ascii"));
    expect(iconGlyph("laterActive", "ascii")).not.toBe(iconGlyph("laterInactive", "ascii"));
    expect(iconAnimations.checking.ascii.frames).toEqual(["..."]);
  });

  test("font coverage includes animated cells, compact trees, and private-use controls", () => {
    const points = iconCodepoints();
    expect([...points]).toEqual([...new Set(points)].sort((a, b) => a - b));
    for (const point of [
      0x21bb, 0x2502, 0x2514, 0x251c, 0x2801, 0x280f, 0x2824, 0xeba0, 0xeb2b, 0xf4ab, 0xf43a,
      0xf48e,
    ])
      expect(points).toContain(point);
    expect(iconCodepoints("unicode")).not.toContain(0xeba0);
    expect(iconCodepoints("nerd")).toContain(0xeba0);
    expect(iconCodepoints("nerd")).not.toContain(0x231b);
    expect(Object.isFrozen(points)).toBe(true);
    expect(Object.isFrozen(iconCatalog.pinActive.nerd)).toBe(true);
    expect(Object.isFrozen(iconAnimations.busy.nerd.frames)).toBe(true);
  });

  test("the Later clock and compact tree retain distinct states in the font and fallback", () => {
    expect(iconGlyph("laterActive", "nerd")).toBe("\uF4AB");
    expect(iconGlyph("laterInactive", "nerd")).toBe("\uF43A");
    for (const mode of iconModes) {
      expect(iconGlyph("laterActive", mode)).not.toBe(iconGlyph("laterInactive", mode));
      expect(iconGlyph("treeBranch", mode)).not.toBe(iconGlyph("treeLast", mode));
      for (const name of ["treeBranch", "treeLast", "treeVertical"] as const)
        expect(iconCatalog[name][mode].cells).toBe(1);
    }
  });

  test("the visual proof aligns columns and includes the last frame of each animation", () => {
    const rows = iconProofRows();
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
    expect(rows.every((row) => Bun.stringWidth(row.text) === 38)).toBe(true);
    expect(rows.find((row) => row.id === "retry")?.text).toContain("↻");
    expect(rows.find((row) => row.id === "busy-9")?.text).toContain("⠏");
    expect(rows.find((row) => row.id === "checking-11")?.text).toContain("⠤⠂");
    expect(rows.filter((row) => row.id.startsWith("busy-")).length).toBe(10);
    expect(rows.filter((row) => row.id.startsWith("checking-")).length).toBe(12);
  });
});
