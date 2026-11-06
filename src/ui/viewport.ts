import type { SidebarRow } from "./model";
import type { MotionNode, MotionSurface } from "./motion";

/** Keep complete scroll geometry while only mounting the nearby native text buffers. */
export function sidebarRowHeights(options: {
  rows: readonly SidebarRow[];
  activeId: string | undefined;
  topLevel: ReadonlySet<string>;
  expandedContext: ReadonlySet<string>;
  expandedChildren: ReadonlySet<string>;
  comfortable: boolean;
  childrenFor(id: string): readonly SidebarRow[];
}): ReadonlyMap<string, number> {
  const heights = new Map<string, number>();
  const base = (id: string) =>
    3 +
    Number(id === options.activeId) +
    Number(options.comfortable) +
    (options.expandedContext.has(id) ? 3 : 0);
  // The read model supplies an acyclic forest. An iterative postorder also avoids
  // using the JavaScript call stack for a long chain of expanded live descendants.
  for (const row of options.rows) {
    const pending = [{ id: row.session.id, finish: false }];
    while (pending.length > 0) {
      const item = pending.pop()!;
      if (heights.has(item.id)) continue;
      const children = options.expandedChildren.has(item.id) ? options.childrenFor(item.id) : [];
      if (!item.finish) {
        pending.push({ ...item, finish: true });
        for (const child of children)
          if (!options.topLevel.has(child.session.id) && !heights.has(child.session.id))
            pending.push({ id: child.session.id, finish: false });
      } else {
        heights.set(
          item.id,
          base(item.id) +
            children.reduce(
              (total, child) =>
                total +
                (options.topLevel.has(child.session.id)
                  ? 1
                  : (heights.get(child.session.id) ?? base(child.session.id))),
              0,
            ),
        );
      }
    }
  }
  return heights;
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
