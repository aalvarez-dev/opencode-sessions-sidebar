import type { SidebarRow } from "./model";
import type { MotionNode, MotionSurface } from "./motion";

/** Keep complete scroll geometry while only mounting the nearby native text buffers. */
export function sidebarRowHeights(options: {
  rows: readonly SidebarRow[];
  activeId: string | undefined;
  topLevel: ReadonlySet<string>;
  expandedContext: ReadonlySet<string>;
  expandedChildren: ReadonlySet<string>;
  /** Whole-cell separation after a full session; compact child lines have no gap. */
  rowGap: number;
  childrenFor(id: string): readonly SidebarRow[];
}): ReadonlyMap<string, number> {
  const heights = new Map<string, number>();
  const compactSizes = new Map<string, number>();
  const base = (id: string) =>
    3 +
    Number(id === options.activeId) +
    options.rowGap +
    (options.expandedContext.has(id) ? 3 : 0);
  // Every live descendant is a single compact tree line. A promoted child is a
  // reference and its subtree belongs to its full row elsewhere. Compute sizes
  // once across the forest, even when several roots have their children open.
  for (const row of options.rows) {
    const pending = [{ id: row.session.id, finish: false }];
    while (pending.length > 0) {
      const item = pending.pop()!;
      if (compactSizes.has(item.id)) continue;
      const children = options.childrenFor(item.id);
      if (!item.finish) {
        pending.push({ ...item, finish: true });
        for (const child of children)
          if (!options.topLevel.has(child.session.id) && !compactSizes.has(child.session.id))
            pending.push({ id: child.session.id, finish: false });
      } else {
        compactSizes.set(
          item.id,
          1 +
            children.reduce(
              (total, child) =>
                total +
                (options.topLevel.has(child.session.id)
                  ? 1
                  : (compactSizes.get(child.session.id) ?? 1)),
              0,
            ),
        );
      }
    }
  }
  for (const row of options.rows)
    heights.set(
      row.session.id,
      base(row.session.id) +
        (options.expandedChildren.has(row.session.id)
          ? (compactSizes.get(row.session.id) ?? 1) - 1
          : 0),
    );
  return heights;
}

export interface SidebarChildLine {
  readonly row: SidebarRow;
  readonly depth: number;
  /** Only the first three ancestor guides can be shown in the narrow sidebar. */
  readonly guides: number;
  readonly last: boolean;
  readonly promoted: boolean;
}

/** Flat iterative traversal keeps deep live trees scrollable without recursive components. */
export function sidebarChildLines(
  parentId: string,
  childrenFor: (id: string) => readonly SidebarRow[],
  topLevel: ReadonlySet<string>,
): readonly SidebarChildLine[] {
  const result: SidebarChildLine[] = [];
  const seen = new Set([parentId]);
  const pending: SidebarChildLine[] = [];
  const add = (id: string, depth: number, guides: number) => {
    const children = childrenFor(id);
    for (let index = children.length - 1; index >= 0; index--) {
      const row = children[index]!;
      pending.push({
        row,
        depth,
        guides,
        last: index === children.length - 1,
        promoted: topLevel.has(row.session.id),
      });
    }
  };
  add(parentId, 0, 0);
  while (pending.length > 0) {
    const line = pending.pop()!;
    if (seen.has(line.row.session.id)) continue;
    seen.add(line.row.session.id);
    result.push(line);
    if (!line.promoted)
      add(
        line.row.session.id,
        line.depth + 1,
        line.depth < 3 && !line.last ? line.guides | (1 << line.depth) : line.guides,
      );
  }
  return result;
}

interface Clip {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function frameVisibility(surface: MotionSurface, overscan: number) {
  const terminal: Clip = {
    left: 0,
    top: 0,
    right: surface.terminalWidth,
    bottom: surface.terminalHeight,
  };
  const clips = new Map<MotionNode, Clip | null>();
  function clipFor(node: MotionNode | null): Clip | null {
    if (!node) return null;
    const cached = clips.get(node);
    if (cached !== undefined) return cached;
    const path: MotionNode[] = [];
    let current: MotionNode | null = node;
    while (current && !clips.has(current)) {
      path.push(current);
      if (current === surface.root) break;
      current = current.parent;
    }
    let clip =
      current && clips.has(current)
        ? clips.get(current)!
        : current === surface.root
          ? terminal
          : null;
    while (path.length > 0) {
      const ancestor = path.pop()!;
      if (!ancestor.visible || ancestor.isDestroyed || ancestor.opacity <= 0) clip = null;
      else if (clip && ancestor.overflow !== "visible") {
        const x = ancestor.screenX;
        const y = ancestor.screenY;
        clip = {
          left: Math.max(clip.left, x),
          top: Math.max(clip.top, y),
          right: Math.min(clip.right, x + ancestor.width),
          bottom: Math.min(clip.bottom, y + ancestor.height),
        };
      }
      clips.set(ancestor, clip);
    }
    return clips.get(node)!;
  }
  return (node: MotionNode | undefined): boolean => {
    if (!node || node.isDestroyed || !node.visible || node.opacity <= 0) return false;
    const clip = node === surface.root ? terminal : clipFor(node.parent);
    if (!clip) return false;
    const { left, top, right, bottom } = clip;
    const width = node.width;
    const height = node.height;
    const x = node.screenX;
    const y = node.screenY;
    return (
      right > left &&
      bottom > top &&
      width > 0 &&
      height > 0 &&
      x < right &&
      x + width > left &&
      y < bottom + overscan &&
      y + height > top - overscan
    );
  };
}

/**
 * One view-owned frame listener, no polling or per-row timers. The lightweight
 * shells remain in the host's scrollbox so its scrollbar and mouse wheel retain
 * their native behavior. Offscreen text-buffer components are disposed, not hidden.
 */
export function createSidebarViewport(surface: MotionSurface, overscan = 12) {
  const entries = new Set<{
    element(): MotionNode | undefined;
    mounted(value: boolean): void;
    visible: boolean;
  }>();
  let disposed = false;
  function refresh() {
    if (disposed) return;
    if (surface.isDestroyed) return dispose();
    // Most rows share the same group and scrollbox ancestors. Resolve that clip
    // once per frame, rather than walking the same chain for every offscreen row.
    // Never retain it across frames: scrolling, resizing or visibility may change.
    const nearby = frameVisibility(surface, overscan);
    for (const entry of entries) {
      const next = nearby(entry.element());
      if (next === entry.visible) continue;
      entry.visible = next;
      entry.mounted(next);
    }
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    entries.clear();
    surface.off("frame", refresh);
    surface.off("destroy", dispose);
  }
  surface.on("frame", refresh);
  surface.on("destroy", dispose);
  return {
    track(options: { element(): MotionNode | undefined; mounted(value: boolean): void }) {
      const entry = { ...options, visible: false };
      if (!disposed) entries.add(entry);
      return () => entries.delete(entry);
    },
    dispose,
  };
}
