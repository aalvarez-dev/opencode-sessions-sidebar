import { RGBA } from "@opentui/core";

function luminance(color: RGBA): number {
  const linear = (value: number) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
}

function over(color: RGBA, background: RGBA): RGBA {
  if (color.a === 1) return color;
  return RGBA.fromValues(
    color.r * color.a + background.r * (1 - color.a),
    color.g * color.a + background.g * (1 - color.a),
    color.b * color.a + background.b * (1 - color.a),
  );
}

/**
 * Keep secondary labels and available, unselected actions readable on their panel.
 * Approach 6:1 using only the host's muted/normal text colors, capped by normal text.
 * An already readable color is retained. Indexed/default colors are controlled by
 * the terminal; their RGB fallback cannot prove its actual palette. Preserve them.
 * A transparent panel has an unknown backdrop: preserve it without a contrast claim.
 * Memoize once per theme/panel; this has no frame, row, or timer work of its own.
 */
export function readableMutedColor(muted: RGBA, foreground: RGBA, background: RGBA): RGBA {
  if (
    background.a !== 1 ||
    muted.intent !== "rgb" ||
    foreground.intent !== "rgb" ||
    background.intent !== "rgb"
  )
    return muted;
  const panel = luminance(background);
  const contrast = (color: RGBA) => {
    const light = luminance(color);
    return (Math.max(light, panel) + 0.05) / (Math.min(light, panel) + 0.05);
  };
  const start = over(muted, background);
  const end = over(foreground, background);
  const initialContrast = contrast(start);
  const normalContrast = contrast(end);
  if (initialContrast >= 6 || normalContrast <= initialContrast) return muted;
  const target = Math.min(6, normalContrast);
  let low = 0;
  let high = 1;
  let result = end;
  // Measure quantized RGBA candidates so the returned terminal RGB meets the target.
  // The bounded search retains a known passing endpoint even for colored themes.
  for (let step = 0; step < 12; step++) {
    const amount = (low + high) / 2;
    const candidate = RGBA.fromValues(
      start.r + (end.r - start.r) * amount,
      start.g + (end.g - start.g) * amount,
      start.b + (end.b - start.b) * amount,
    );
    if (contrast(candidate) >= target) {
      high = amount;
      result = candidate;
    } else low = amount;
  }
  return result;
}
