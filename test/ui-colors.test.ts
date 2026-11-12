import { describe, expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { readableMutedColor } from "../src/ui/colors";

const hex = RGBA.fromHex;

// Check the actual 8-bit output against the contrast formula, independently of the search.
function contrast(a: RGBA, b: RGBA): number {
  const light = (color: RGBA) =>
    color
      .toInts()
      .slice(0, 3)
      .reduce((sum, byte, channel) => {
        const value = byte / 255;
        const linear = value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        return sum + linear * [0.2126, 0.7152, 0.0722][channel]!;
      }, 0);
  const [dark, bright] = [light(a), light(b)].sort((x, y) => x - y);
  return (bright! + 0.05) / (dark! + 0.05);
}

describe("theme-derived sidebar secondary colors", () => {
  test("makes current dark metadata readable while retaining title hierarchy and theme inputs", () => {
    const muted = hex("#808080");
    const foreground = hex("#eeeeee");
    const panel = hex("#141414");
    const result = readableMutedColor(muted, foreground, panel);
    expect(contrast(muted, panel)).toBeLessThan(6);
    expect(contrast(result, panel)).toBeGreaterThanOrEqual(6);
    expect(contrast(result, panel)).toBeLessThan(contrast(foreground, panel));
    expect(result.toInts()).toEqual([148, 148, 148, 255]);
    expect(muted.toInts()).toEqual([128, 128, 128, 255]);
    expect(foreground.toInts()).toEqual([238, 238, 238, 255]);
    expect(panel.toInts()).toEqual([20, 20, 20, 255]);
  });

  test("darkens weak secondary text on a light theme rather than applying dark-theme colors", () => {
    const muted = hex("#96938d");
    const foreground = hex("#252525");
    const panel = hex("#f4f3ef");
    const result = readableMutedColor(muted, foreground, panel);
    expect(contrast(result, panel)).toBeGreaterThanOrEqual(6);
    expect(result.r).toBeLessThan(muted.r);
    expect(result.g).toBeLessThan(muted.g);
    expect(result.b).toBeLessThan(muted.b);
    expect(contrast(result, panel)).toBeLessThan(contrast(foreground, panel));
  });

  test("retains readable host colors and their indexed/default intent without allocating replacements", () => {
    const panel = hex("#141414");
    const muted = RGBA.fromIndex(247, "#9e9e9e");
    expect(readableMutedColor(muted, hex("#eeeeee"), panel)).toBe(muted);
    const normal = RGBA.defaultForeground("#eeeeee");
    expect(readableMutedColor(normal, normal, panel)).toBe(normal);
  });

  test("keeps colored themes within the supplied palette instead of forcing neutral gray", () => {
    const muted = hex("#49566d");
    const foreground = hex("#a4d9fd");
    const panel = hex("#142132");
    const result = readableMutedColor(muted, foreground, panel);
    expect(contrast(result, panel)).toBeGreaterThanOrEqual(6);
    expect(contrast(result, panel)).toBeLessThan(contrast(foreground, panel));
    expect(result.b).toBeGreaterThan(result.g);
    expect(result.g).toBeGreaterThan(result.r);
    for (const channel of ["r", "g", "b"] as const) {
      expect(result[channel]).toBeGreaterThanOrEqual(muted[channel]);
      expect(result[channel]).toBeLessThanOrEqual(foreground[channel]);
    }
  });

  test("does not replace terminal-controlled colors using an unverified RGB fallback", () => {
    const muted = hex("#404040");
    const foreground = hex("#eeeeee");
    const panel = hex("#141414");
    const indexed = RGBA.fromIndex(8, "#404040");
    expect(readableMutedColor(indexed, foreground, panel)).toBe(indexed);
    expect(readableMutedColor(muted, RGBA.defaultForeground("#eeeeee"), panel)).toBe(muted);
    expect(readableMutedColor(muted, foreground, RGBA.defaultBackground("#141414"))).toBe(muted);
  });

  test("accounts for text alpha over an opaque panel and makes no promise over an unknown backdrop", () => {
    const muted = hex("#eeeeee40");
    const foreground = hex("#eeeeeecc");
    const panel = hex("#141414");
    const result = readableMutedColor(muted, foreground, panel);
    expect(result.a).toBe(1);
    expect(contrast(result, panel)).toBeGreaterThanOrEqual(6);
    expect(result.r).toBeLessThan(foreground.r);
    expect(muted.toInts()).toEqual([238, 238, 238, 64]);
    expect(readableMutedColor(muted, foreground, hex("#14141480"))).toBe(muted);
  });

  test("caps at the host foreground when its contrast is limited and never weakens better metadata", () => {
    const panel = hex("#141414");
    const muted = hex("#404040");
    const foreground = hex("#808080");
    const result = readableMutedColor(muted, foreground, panel);
    expect(result.toInts()).toEqual(foreground.toInts());
    expect(contrast(result, panel)).toBeLessThan(6);
    expect(readableMutedColor(foreground, muted, panel)).toBe(foreground);
    expect(readableMutedColor(panel, panel, panel)).toBe(panel);
  });
});
