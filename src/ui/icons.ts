import type { IconMode } from "./model";

export const iconModes = ["unicode", "ascii", "nerd"] as const;

export interface IconGlyph {
  readonly text: string;
  /** Expected terminal cells, not a measurement of the client's font. */
  readonly cells: number;
}

export interface IconDefinition {
  readonly label: string;
  readonly unicode: IconGlyph;
  readonly ascii: IconGlyph;
  readonly nerd: IconGlyph;
}

const glyph = (text: string, cells = 1): IconGlyph => Object.freeze({ text, cells });
const entry = (
  label: string,
  unicode: IconGlyph,
  ascii: IconGlyph,
  nerd = unicode,
): IconDefinition => Object.freeze({ label, unicode, ascii, nerd });

/** Every sidebar-owned icon lives here; text labels and user content are not icon glyphs. */
export const iconCatalog = Object.freeze({
  permission: entry("Permission", glyph("!"), glyph("!")),
  question: entry("Question", glyph("?"), glyph("?")),
  retry: entry("Retry", glyph("↻"), glyph("~")),
  busy: entry("Busy", glyph("⠋"), glyph("-")),
  error: entry("Error", glyph("×"), glyph("x")),
  checking: entry("Checking", glyph("⠤⠄", 2), glyph("...", 3)),
  unknown: entry("Unknown", glyph("◌"), glyph("?")),
  idle: entry("Idle", glyph("·"), glyph(".")),
  completion: entry("Completed", glyph("✓"), glyph("+")),
  pinActive: entry("Pin active", glyph("◆"), glyph("P"), glyph("\uEBA0")),
  pinInactive: entry("Pin inactive", glyph("◇"), glyph("p"), glyph("\uEB2B")),
  // U+231B is wide in the Unicode width tables. A terminal may render it as emoji.
  // Octicons clock-fill/clock in the pinned Nerd Font: the Later control is a clock,
  // with separate filled/outline states so membership is not conveyed by color alone.
  laterActive: entry("Later active", glyph("⌛", 2), glyph("L"), glyph("\uF4AB")),
  laterInactive: entry("Later inactive", glyph("≡"), glyph("l"), glyph("\uF43A")),
  expanded: entry("Expanded", glyph("▾"), glyph("v")),
  collapsed: entry("Collapsed", glyph("▸"), glyph(">")),
  delete: entry("Delete", glyph("⌫"), glyph("del", 3), glyph("\uF48E")),
  menu: entry("Menu", glyph("…"), glyph("...", 3)),
  promoted: entry("Shown elsewhere", glyph("↗"), glyph(">>", 2)),
  treeBranch: entry("Tree branch", glyph("├"), glyph("|")),
  treeLast: entry("Tree last", glyph("└"), glyph("`")),
  treeVertical: entry("Tree vertical", glyph("│"), glyph("|")),
  create: entry("Create", glyph("+"), glyph("+")),
});

export type IconName = keyof typeof iconCatalog;

export function iconGlyph(name: IconName, mode: IconMode): string {
  return iconCatalog[name][mode].text;
}

export const busyFrames = Object.freeze(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]);
export const checkingFrames = Object.freeze([
  "⠤⠄",
  "⠢⠄",
  "⠡⠄",
  "⠢⠄",
  "⠤⠄",
  "⠔⠄",
  "⠌⠄",
  "⠔⠄",
  "⠤⠄",
  "⠤⠂",
  "⠤⠁",
  "⠤⠂",
]);
const asciiBusyFrames = Object.freeze(["-", "\\", "|", "/"]);
const asciiCheckingFrames = Object.freeze(["..."]);

function animation(frames: readonly string[], cells: number) {
  return Object.freeze({ frames, cells });
}

/** Font verification must include all animation frames, not only the first visible frame. */
export const iconAnimations = Object.freeze({
  busy: Object.freeze({
    periodMs: 80,
    unicode: animation(busyFrames, 1),
    nerd: animation(busyFrames, 1),
    ascii: animation(asciiBusyFrames, 1),
  }),
  checking: Object.freeze({
    periodMs: 160,
    unicode: animation(checkingFrames, 2),
    nerd: animation(checkingFrames, 2),
    ascii: animation(asciiCheckingFrames, 3),
  }),
});

/** Sorted coverage requirements for preparing fonts; no host/runtime/font discovery involved. */
export function iconCodepoints(mode?: IconMode): readonly number[] {
  const points = new Set<number>();
  const modes = mode === undefined ? iconModes : [mode];
  const add = (text: string) => {
    for (const character of text) points.add(character.codePointAt(0)!);
  };
  for (const current of modes) {
    for (const icon of Object.values(iconCatalog)) add(icon[current].text);
    for (const item of Object.values(iconAnimations))
      for (const frame of item[current].frames) add(frame);
  }
  return Object.freeze([...points].sort((a, b) => a - b));
}

export interface IconProofRow {
  readonly id: string;
  readonly text: string;
}

/** Static visual proof: matching right-hand bars expose missing or unexpectedly wide glyphs. */
export function iconProofRows(): readonly IconProofRow[] {
  const sample = (item: IconGlyph) => `|${item.text}${" ".repeat(3 - item.cells)}|`;
  const row = (id: string, label: string, values: Record<IconMode, IconGlyph>) =>
    Object.freeze({
      id,
      text: `${label.padEnd(16)} ${iconModes.map((mode) => sample(values[mode])).join("   ")}`,
    });
  const rows = Object.entries(iconCatalog).map(([id, icon]) => row(id, icon.label, icon));
  for (const [name, item] of Object.entries(iconAnimations)) {
    const length = Math.max(...iconModes.map((mode) => item[mode].frames.length));
    for (let index = 0; index < length; index++) {
      const frame = (mode: IconMode) =>
        glyph(item[mode].frames[index % item[mode].frames.length]!, item[mode].cells);
      rows.push(
        row(`${name}-${index}`, `${name} ${index + 1}`, {
          unicode: frame("unicode"),
          ascii: frame("ascii"),
          nerd: frame("nerd"),
        }),
      );
    }
  }
  return Object.freeze(rows);
}
