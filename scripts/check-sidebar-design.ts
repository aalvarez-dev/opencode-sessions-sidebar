/** Shared geometry/color acceptance of the real TUI frame; pixel review remains separate. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { iconGlyph } from "../src/ui/icons";
import { designSessions } from "./sidebar-design-fixture";

export interface DesignSnapshot {
  design: { nativeExecutionValidated: false; ids: Record<string, string>; productSha256: string };
  dialogDepth: number;
  publicContext: { project: { worktree: string } };
  palette: Record<string, number[]>;
  geometry: {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    visible: boolean;
    text?: string;
  }[];
  frame: {
    width: number;
    height: number;
    lines: { text: string; width: number; fg: number[] }[][];
  };
}

export function checkDesign(snapshot: DesignSnapshot) {
  assert.equal(snapshot.design.nativeExecutionValidated, false);
  assert.equal(snapshot.dialogDepth, 0, "Design capture must have no modal dialog.");
  const ids = snapshot.design.ids;
  const lines = snapshot.frame.lines.map((line) => line.map((span) => span.text).join(""));
  const text = lines.join("\n");
  const checks: string[] = [];
  const node = (id: string) => {
    const found = snapshot.geometry.find(
      (item) =>
        item.id === id &&
        item.visible &&
        item.width > 0 &&
        item.height > 0 &&
        item.y >= 0 &&
        item.y + item.height <= snapshot.frame.height,
    );
    assert(found, `Missing fully visible design element ${id}.\n${text}`);
    return found;
  };
  const content = (id: string) => {
    const item = node(id);
    return lines
      .slice(item.y, item.y + item.height)
      .map((line) => [...line].slice(item.x, item.x + item.width).join(""))
      .join("\n")
      .trim();
  };
  const heading = node("sidebar-heading");
  const create = node("sidebar-create");
  assert.equal(heading.y, create.y, "Heading and creation action must share one row.");
  assert(content("sidebar-heading").includes("Active session:"));
  assert(content("sidebar-create").includes("new session +"));
  checks.push("Active heading and creation share one row.");
  assert(!snapshot.geometry.some((item) => item.id === `sidebar-session-${ids.release}-menu`));
  const parentTitle = node(`sidebar-session-${ids.release}-title`);
  const controls = node(`sidebar-session-${ids.release}-controls`);
  const context = node(`sidebar-session-${ids.release}-context`);
  const completion = node(`sidebar-session-${ids.release}-completion`);
  assert.equal(controls.y, parentTitle.y + 1);
  const security = node(`sidebar-child-${ids.security}`);
  const backend = node(`sidebar-child-${ids.backend}`);
  assert.equal(security.height, 1);
  assert.equal(backend.height, 1);
  assert.equal(security.y, controls.y + 1);
  assert.equal(backend.y, controls.y + 2);
  assert.equal(context.y, controls.y + 3);
  assert.equal(completion.y, context.y + 1);
  assert.equal(completion.x, parentTitle.x, "Completion action must align with title content.");
  assert.equal(
    content(completion.id),
    `Unmark completed ${iconGlyph("completion", "nerd")}`,
    "The pinned-font design scenario must render the exact catalog completion glyph after its action label.",
  );
  assert(!snapshot.geometry.some((item) => item.id === `sidebar-session-${ids.security}-controls`));
  assert(!snapshot.geometry.some((item) => item.id === `sidebar-session-${ids.backend}-context`));
  checks.push(
    "Active live children open as compact one-line rows above context and aligned completion.",
  );
  const groupNodes = ["later", "pins", "sessions"].map((id) => node(`sidebar-group-${id}-label`));
  for (const [index, label] of ["Later (1)", "Pinned sessions (1)", "Other sessions (1)"].entries())
    assert(content(groupNodes[index]!.id).includes(label));
  assert(groupNodes[0]!.y < groupNodes[1]!.y && groupNodes[1]!.y < groupNodes[2]!.y);
  for (const entry of designSessions.filter((entry) => !("parent" in entry)))
    assert(
      content(`sidebar-session-${ids[entry.key]}-title`).includes(entry.title),
      `The approved ${entry.key} title must be visible in the actual frame, not merely mounted outside its scroll clip.`,
    );
  assert(content(`sidebar-session-${ids.docs}-context`).includes("[R][B][W]"));
  checks.push("Later, Pinned and Other each show one session in the approved order.");
  const repositoryName = snapshot.publicContext.project.worktree
    .split(/[\\/]/)
    .filter(Boolean)
    .at(-1);
  assert.equal(
    repositoryName,
    "opencode-sessions-sidebar",
    "Use the approved deterministic repository fixture.",
  );
  const contextLabel = ` ${repositoryName}`;
  const ellipsis = iconGlyph("menu", "nerd");
  for (const key of ["release", "branches", "review", "docs"]) {
    const contextRow = node(`sidebar-session-${ids[key]}-context`);
    const lastSelector = node(`sidebar-session-${ids[key]}-context-select-W`);
    const valueStart = lastSelector.x + lastSelector.width;
    // Measure the space the parent actually owns, not a potentially overflowing
    // label's own width: otherwise a clipped full string could falsely pass.
    const available = contextRow.x + contextRow.width - valueStart;
    assert(
      available >= Bun.stringWidth(ellipsis),
      "The context value must retain at least its truncation indicator.",
    );
    const rendered = [...lines[contextRow.y]!]
      .slice(valueStart, valueStart + available)
      .join("")
      .trimEnd();
    if (Bun.stringWidth(contextLabel) > available) {
      assert(
        rendered.endsWith(ellipsis),
        `Clipped ${key} context must end with the Nerd ellipsis, not silently lose characters.`,
      );
      const expected =
        Bun.sliceAnsi(contextLabel, 0, available - Bun.stringWidth(ellipsis)) + ellipsis;
      assert.equal(
        rendered,
        expected,
        `The ${key} context must preserve its beginning and put the ellipsis in its final visible cell.`,
      );
    } else {
      assert.equal(
        rendered,
        contextLabel,
        `The complete ${key} context fits and must not be shortened.`,
      );
    }
  }
  checks.push(
    "All four context values either fit completely or end with the catalog ellipsis in their actual available width.",
  );
  const colorAt = (id: string, wanted: string) => {
    const item = node(id);
    let column = 0;
    for (const span of snapshot.frame.lines[item.y]!) {
      const start = column;
      column += span.width;
      if (start + span.width <= item.x || start >= item.x + item.width) continue;
      if (span.text.includes(wanted)) return span.fg;
    }
    return undefined;
  };
  assert.deepEqual(colorAt(parentTitle.id, "Preparar"), snapshot.palette.success);
  assert.deepEqual(colorAt(`sidebar-session-${ids.release}-status`, "?"), snapshot.palette.warning);
  assert.deepEqual(
    colorAt(`sidebar-child-${ids.security}-label`, "security.reviewer"),
    [195, 160, 221],
  );
  assert.deepEqual(colorAt(`sidebar-child-${ids.backend}-label`, "backend"), [145, 189, 221]);
  checks.push(
    "Completion, independent question status and configured agent colors are visible together.",
  );
  assert(
    !text.includes("Session data incomplete"),
    "Health warnings must not be hidden in design evidence.",
  );
  assert(
    !snapshot.geometry.some((item) => item.text === "Saved"),
    "Capture must not include a Saved toast.",
  );
  checks.push("No modal, Saved toast or incomplete-session warning obscures the design.");
  return {
    passed: true,
    nativeExecutionValidated: false,
    checks,
    pluginBounds: {
      x: heading.x,
      y: heading.y,
      width: snapshot.frame.width - heading.x,
      height: node(`sidebar-session-${ids.docs}-context`).y + 1 - heading.y,
    },
  };
}

if (import.meta.main) {
  assert(process.argv[2], "Pass a real observer snapshot JSON path.");
  console.log(
    JSON.stringify(checkDesign(JSON.parse(await readFile(process.argv[2], "utf8"))), null, 2),
  );
}
