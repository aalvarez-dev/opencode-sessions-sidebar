import type { Renderable } from "@opentui/core";

export type MotionKind = "busy" | "checking" | null;

export const checkingFrames = [
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
] as const;

const busyFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const asciiBusyFrames = ["-", "\\", "|", "/"] as const;

/** The public geometry needed to respect terminal and scroll-viewport clipping. */
export interface MotionNode
  extends Pick<
    Renderable,
    "visible" | "isDestroyed" | "screenX" | "screenY" | "width" | "height" | "overflow" | "opacity"
  > {
  readonly parent: MotionNode | null;
}

export interface MotionSurface {
  readonly root: MotionNode;
  readonly isDestroyed: boolean;
  readonly terminalWidth: number;
  readonly terminalHeight: number;
  on(event: "frame" | "destroy", listener: () => void): unknown;
  off(event: "frame" | "destroy", listener: () => void): unknown;
}

export interface MotionClock {
  now(): number;
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemClock: MotionClock = {
  now: () => performance.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function visible(node: MotionNode | undefined, surface: MotionSurface): boolean {
  if (!node) return false;
  let left = Math.max(0, node.screenX);
  let top = Math.max(0, node.screenY);
  let right = Math.min(surface.terminalWidth, node.screenX + node.width);
  let bottom = Math.min(surface.terminalHeight, node.screenY + node.height);
  for (let ancestor: MotionNode | null = node; ancestor; ancestor = ancestor.parent) {
    if (!ancestor.visible || ancestor.isDestroyed || ancestor.opacity <= 0) return false;
    if (ancestor.overflow !== "visible") {
      left = Math.max(left, ancestor.screenX);
      top = Math.max(top, ancestor.screenY);
      right = Math.min(right, ancestor.screenX + ancestor.width);
      bottom = Math.min(bottom, ancestor.screenY + ancestor.height);
    }
    if (right <= left || bottom <= top) return false;
    if (ancestor === surface.root) return true;
  }
  // Detached renderables must not retain animation work after a route or group changes.
  return false;
}

interface Entry {
  element(): MotionNode | undefined;
  frame(glyph: string): void;
  kind: MotionKind;
  ascii: boolean;
  reduced: boolean;
  glyph: string;
}

function glyph(entry: Entry, elapsed: number): string {
  if (entry.kind === null) return "";
  if (entry.kind === "checking" && entry.ascii) return "...";
  const frames =
    entry.kind === "checking" ? checkingFrames : entry.ascii ? asciiBusyFrames : busyFrames;
  const period = entry.kind === "checking" ? 160 : 80;
  return frames[entry.reduced ? 0 : Math.floor(elapsed / period) % frames.length]!;
}

/**
 * One view-owned clock; only visible busy/checking entries request animation work.
 * Host render events wake motion after scrolling or layout without an idle poller.
 * Call set() from the row's reactive effect and dispose() from its cleanup.
 */
export function createSidebarMotion(surface: MotionSurface, clock: MotionClock = systemClock) {
  const animated = new Set<Entry>();
  const origin = clock.now();
  let disposed = false;
  let timer: unknown;
  let timerDue = Infinity;

  function cancelTimer() {
    if (timer !== undefined) clock.clearTimeout(timer);
    timer = undefined;
    timerDue = Infinity;
  }

  function emit(entry: Entry, next: string) {
    if (entry.glyph === next) return;
    entry.glyph = next;
    entry.frame(next);
  }

  function refresh() {
    if (disposed) return;
    if (surface.isDestroyed) return dispose();
    const now = clock.now();
    const elapsed = Math.max(0, now - origin);
    let delay = Infinity;
    for (const entry of animated) {
      if (!visible(entry.element(), surface)) continue;
      emit(entry, glyph(entry, elapsed));
      const period = entry.kind === "checking" ? 160 : 80;
      delay = Math.min(delay, period - (elapsed % period));
    }
    if (disposed) return;
    if (delay === Infinity) return cancelTimer();
    const due = now + delay;
    if (timer !== undefined && timerDue === due) return;
    cancelTimer();
    timerDue = due;
    timer = clock.setTimeout(() => {
      timer = undefined;
      timerDue = Infinity;
      refresh();
    }, delay);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelTimer();
    animated.clear();
    surface.off("frame", refresh);
    surface.off("destroy", dispose);
  }

  surface.on("frame", refresh);
  surface.on("destroy", dispose);

  return {
    track(options: { element(): MotionNode | undefined; frame(glyph: string): void }) {
      const entry: Entry = { ...options, kind: null, ascii: false, reduced: false, glyph: "" };
      let removed = false;
      return {
        set(kind: MotionKind, ascii = false, reduced = false) {
          if (disposed || removed) return;
          if (entry.kind === kind && entry.ascii === ascii && entry.reduced === reduced) return;
          entry.kind = kind;
          entry.ascii = ascii;
          entry.reduced = reduced;
          emit(entry, glyph(entry, 0));
          if (kind !== null && !reduced && !(kind === "checking" && ascii)) animated.add(entry);
          else animated.delete(entry);
          refresh();
        },
        dispose() {
          if (removed) return;
          removed = true;
          animated.delete(entry);
          refresh();
        },
      };
    },
    dispose,
  };
}
