import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createSidebarViewport, sidebarChildLines, sidebarRowHeights } from "../src/ui/viewport";
import type { MotionNode } from "../src/ui/motion";
import type { SidebarRow } from "../src/ui/model";

function node(overrides: Partial<MotionNode> = {}): MotionNode {
  return {
    visible: true,
    isDestroyed: false,
    opacity: 1,
    screenX: 0,
    screenY: 0,
    width: 40,
    height: 20,
    overflow: "visible",
    parent: null,
    ...overrides,
  };
}

function row(id: string): SidebarRow {
  return {
    session: {
      id,
      key: id,
      title: id,
      directory: "/synthetic",
      projectId: "synthetic",
      workspaceId: null,
      parentId: null,
      activity: "idle",
      permissions: 0,
      questions: 0,
      updatedAt: 0,
    },
    done: false,
    pinned: false,
    later: false,
    summary: { busy: 0, retry: 0, unknown: 0, permissions: 0, questions: 0, errors: 0 },
  };
}

describe("viewport-bounded sidebar mounting", () => {
  test("shares ancestor inspection within a frame and invalidates every frame", () => {
    let ancestorReads = 0;
    let rootVisible = true;
    const root = node();
    Object.defineProperty(root, "visible", {
      get() {
        ancestorReads++;
        return rootVisible;
      },
    });
    const surface = Object.assign(new EventEmitter(), {
      root,
      terminalWidth: 40,
      terminalHeight: 20,
      isDestroyed: false,
    });
    let ancestor = root;
    for (let level = 0; level < 8; level++) {
      ancestor = node({ parent: ancestor });
      Object.defineProperty(ancestor, "visible", {
        get() {
          ancestorReads++;
          return true;
        },
      });
    }
    const groups = [node({ parent: ancestor }), node({ parent: ancestor })];
    const viewport = createSidebarViewport(surface, 0);
    const mounted = new Set<number>();
    const shells = Array.from({ length: 250 }, (_, index) =>
      node({ parent: groups[index % 2]!, height: 3 }),
    );
    for (const [index, shell] of shells.entries())
      viewport.track({
        element: () => shell,
        mounted(value) {
          if (value) mounted.add(index);
          else mounted.delete(index);
        },
      });
    surface.emit("frame");
    expect(mounted.size).toBe(250);
    expect(ancestorReads).toBeLessThanOrEqual(10);
    rootVisible = false;
    ancestorReads = 0;
    surface.emit("frame");
    expect(mounted.size).toBe(0);
    expect(ancestorReads).toBeLessThanOrEqual(10);
    rootVisible = true;
    surface.terminalHeight = 0;
    surface.emit("frame");
    expect(mounted.size).toBe(0);
    surface.terminalHeight = 20;
    surface.emit("frame");
    expect(mounted.size).toBe(250);
    viewport.dispose();
  });

  test("keeps a bounded mounted set while scrolling through the entire list and back", () => {
    const root = node();
    const surface = Object.assign(new EventEmitter(), {
      root,
      terminalWidth: 40,
      terminalHeight: 20,
      isDestroyed: false,
    });
    const clip = node({ parent: root, screenY: 5, height: 10, overflow: "hidden" });
    const viewport = createSidebarViewport(surface, 3);
    const mounted = new Set<number>();
    const shells = Array.from({ length: 1000 }, (_, index) =>
      node({ parent: clip, screenY: 5 + index * 3, height: 3 }),
    );
    const cleanups = shells.map((shell, index) =>
      viewport.track({
        element: () => shell,
        mounted: (visible) => {
          if (visible) mounted.add(index);
          else mounted.delete(index);
        },
      }),
    );
    surface.emit("frame");
    expect([...mounted]).toEqual([0, 1, 2, 3, 4]);
    shells.forEach((shell, index) => Object.assign(shell, { screenY: 5 + (index - 996) * 3 }));
    surface.emit("frame");
    expect([...mounted]).toEqual([995, 996, 997, 998, 999]);
    shells.forEach((shell, index) => Object.assign(shell, { screenY: 5 + index * 3 }));
    surface.emit("frame");
    expect([...mounted]).toEqual([0, 1, 2, 3, 4]);
    expect(surface.listenerCount("frame")).toBe(1);
    cleanups.forEach((cleanup) => cleanup());
    viewport.dispose();
    expect(surface.listenerCount("frame")).toBe(0);
    expect(surface.listenerCount("destroy")).toBe(0);
  });

  test("respects clipping, hidden ancestors, detachment and changed terminal geometry", () => {
    const root = node();
    const surface = Object.assign(new EventEmitter(), {
      root,
      terminalWidth: 40,
      terminalHeight: 20,
      isDestroyed: false,
    });
    const clip = node({ parent: root, screenY: 4, height: 4, overflow: "hidden" });
    const shell = node({ parent: clip, screenY: 9, height: 3 });
    const values: boolean[] = [];
    const viewport = createSidebarViewport(surface, 0);
    const stop = viewport.track({ element: () => shell, mounted: (value) => values.push(value) });
    surface.emit("frame");
    expect(values).toEqual([]);
    Object.assign(clip, { height: 10 });
    surface.emit("frame");
    expect(values).toEqual([true]);
    surface.terminalHeight = 8;
    surface.emit("frame");
    expect(values).toEqual([true, false]);
    surface.terminalHeight = 20;
    Object.assign(clip, { visible: false });
    surface.emit("frame");
    expect(values).toEqual([true, false]);
    Object.assign(clip, { visible: true });
    surface.emit("frame");
    Object.assign(shell, { parent: null });
    surface.emit("frame");
    expect(values).toEqual([true, false, true, false]);
    stop();
    Object.assign(shell, { parent: clip });
    surface.emit("frame");
    expect(values.at(-1)).toBe(false);
    surface.emit("destroy");
    expect(surface.listenerCount("frame")).toBe(0);
  });

  test("reserves expanded context, live descendants, promoted references, completion and density gaps", () => {
    const rows = [row("parent"), row("child"), row("promoted")];
    const heights = sidebarRowHeights({
      rows,
      activeId: "parent",
      topLevel: new Set(["parent", "promoted"]),
      expandedContext: new Set(["parent", "child"]),
      expandedChildren: new Set(["parent"]),
      rowGap: 2,
      childrenFor: (id) => (id === "parent" ? rows.slice(1) : []),
    });
    expect(heights.get("child")).toBe(8); // Only applies if this row is promoted to a full session.
    expect(heights.get("promoted")).toBe(5);
    expect(heights.get("parent")).toBe(11); // 9 own, one compact child, one promoted reference
    const collapsed = sidebarRowHeights({
      rows,
      activeId: "parent",
      topLevel: new Set(["parent", "promoted"]),
      expandedContext: new Set(),
      expandedChildren: new Set(),
      rowGap: 0,
      childrenFor: () => [],
    });
    expect([...collapsed.values()]).toEqual([4, 3, 3]);
  });

  test("calculates a deep expanded forest without recursive stack growth", () => {
    const rows = Array.from({ length: 5000 }, (_, index) => row(String(index)));
    const heights = sidebarRowHeights({
      rows,
      activeId: "0",
      topLevel: new Set(["0"]),
      expandedContext: new Set(),
      expandedChildren: new Set(rows.map((entry) => entry.session.id)),
      rowGap: 0,
      childrenFor: (id) => (Number(id) + 1 < rows.length ? [rows[Number(id) + 1]!] : []),
    });
    expect(heights.get("0")).toBe(5003);
    expect(heights.get("4999")).toBe(3);
  });

  test("flattens live descendants into one line each and stops at promoted roots", () => {
    const rows = [
      row("parent"),
      row("child"),
      row("grandchild"),
      row("promoted"),
      row("elsewhere"),
    ];
    const children = new Map([
      ["parent", [rows[1]!, rows[3]!]],
      ["child", [rows[2]!]],
      ["promoted", [rows[4]!]],
    ]);
    const childrenFor = (id: string) => children.get(id) ?? [];
    const topLevel = new Set(["parent", "promoted"]);
    const lines = sidebarChildLines("parent", childrenFor, topLevel);
    expect(
      lines.map(({ row, depth, guides, last, promoted }) => [
        row.session.id,
        depth,
        guides,
        last,
        promoted,
      ]),
    ).toEqual([
      ["child", 0, 0, false, false],
      ["grandchild", 1, 1, true, false],
      ["promoted", 0, 0, true, true],
    ]);
    const heights = sidebarRowHeights({
      rows,
      activeId: "parent",
      topLevel,
      expandedContext: new Set(["child"]),
      expandedChildren: new Set(["parent", "promoted"]),
      rowGap: 1,
      childrenFor,
    });
    expect(heights.get("parent")).toBe(8); // 3 + action + gap + three compact lines
    expect(heights.get("promoted")).toBe(5); // its own child appears only here
    expect(
      sidebarChildLines("promoted", childrenFor, topLevel).map((line) => line.row.session.id),
    ).toEqual(["elsewhere"]);
  });

  test("flattens deep trees iteratively with bounded guide metadata", () => {
    const rows = Array.from({ length: 5000 }, (_, index) => row(String(index)));
    let reads = 0;
    const lines = sidebarChildLines(
      "0",
      (id) => {
        reads++;
        return Number(id) + 1 < rows.length ? [rows[Number(id) + 1]!] : [];
      },
      new Set(["0"]),
    );
    expect(lines.length).toBe(4999);
    expect(lines.at(-1)?.depth).toBe(4998);
    expect(lines.every((line) => line.guides <= 7)).toBe(true);
    expect(reads).toBe(5000);
  });
});
