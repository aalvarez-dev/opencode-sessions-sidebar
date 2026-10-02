import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  checkingFrames,
  createSidebarMotion,
  type MotionClock,
  type MotionNode,
} from "../src/ui/motion";

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

function fixture() {
  const root = node();
  const surface = Object.assign(new EventEmitter(), {
    root,
    terminalWidth: 40,
    terminalHeight: 20,
    isDestroyed: false,
  });
  let now = 0;
  let nextId = 0;
  const pending = new Map<number, { at: number; run(): void }>();
  const clock: MotionClock = {
    now: () => now,
    setTimeout(run, delay) {
      const id = ++nextId;
      pending.set(id, { at: now + delay, run });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id as number);
    },
  };
  function advance(amount: number) {
    const end = now + amount;
    for (;;) {
      const next = [...pending].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      pending.delete(next[0]);
      now = next[1].at;
      next[1].run();
    }
    now = end;
  }
  return { root, surface, clock, pending, advance };
}

describe("sidebar motion lifetime", () => {
  test("shares one clock, keeps three checking dots, and releases idle/disposed work", () => {
    const f = fixture();
    const motion = createSidebarMotion(f.surface, f.clock);
    const element = node({ parent: f.root, width: 3, height: 1 });
    const busy: string[] = [];
    const checking: string[] = [];
    const a = motion.track({ element: () => element, frame: (frame) => busy.push(frame) });
    const b = motion.track({ element: () => element, frame: (frame) => checking.push(frame) });
    expect(f.pending.size).toBe(0);
    a.set("busy");
    b.set("checking");
    expect(f.pending.size).toBe(1);
    expect(busy).toEqual(["⠋"]);
    expect(checking).toEqual(["⠤⠄"]);
    f.advance(80);
    expect(busy.at(-1)).toBe("⠙");
    expect(checking).toEqual(["⠤⠄"]);
    f.advance(80);
    expect(checking.at(-1)).toBe("⠢⠄");
    a.set(null);
    f.advance(160 * 11);
    expect(checking.slice(0, 12)).toEqual([...checkingFrames]);
    expect(
      checkingFrames.every(
        (frame) =>
          Array.from(frame).reduce(
            (dots, cell) =>
              dots + (cell.codePointAt(0)! - 0x2800).toString(2).replaceAll("0", "").length,
            0,
          ) === 3,
      ),
    ).toBe(true);
    expect(f.pending.size).toBe(1);
    b.dispose();
    expect(f.pending.size).toBe(0);
    motion.dispose();
    expect(f.surface.listenerCount("frame")).toBe(0);
    expect(f.surface.listenerCount("destroy")).toBe(0);
    a.set("busy");
    expect(f.pending.size).toBe(0);
  });

  test("scroll clipping stops motion until a host frame reveals the row again", () => {
    const f = fixture();
    const motion = createSidebarMotion(f.surface, f.clock);
    const viewport = node({ parent: f.root, screenY: 4, height: 3, overflow: "hidden" });
    const element = node({ parent: viewport, screenY: 8, height: 1 });
    const frames: string[] = [];
    const entry = motion.track({ element: () => element, frame: (frame) => frames.push(frame) });
    entry.set("busy");
    expect(f.pending.size).toBe(0);
    f.advance(160);
    expect(frames).toEqual(["⠋"]);
    Object.assign(element, { screenY: 5 });
    f.surface.emit("frame");
    expect(frames.at(-1)).toBe("⠹");
    expect(f.pending.size).toBe(1);
    Object.assign(element, { screenY: 8 });
    f.surface.emit("frame");
    expect(f.pending.size).toBe(0);
    const count = frames.length;
    f.advance(800);
    expect(frames.length).toBe(count);
    motion.dispose();
  });

  test("ignores hidden, detached, destroyed, transparent and terminal-clipped nodes", () => {
    const f = fixture();
    const motion = createSidebarMotion(f.surface, f.clock);
    const element = node({ parent: f.root, width: 2, height: 1 });
    const entry = motion.track({ element: () => element, frame() {} });
    entry.set("busy");
    expect(f.pending.size).toBe(1);
    f.root.visible = false;
    f.surface.emit("frame");
    expect(f.pending.size).toBe(0);
    f.root.visible = true;
    Object.assign(element, { screenX: 40 });
    f.surface.emit("frame");
    expect(f.pending.size).toBe(0);
    Object.assign(element, { screenX: 0 });
    element.opacity = 0;
    f.surface.emit("frame");
    expect(f.pending.size).toBe(0);
    element.opacity = 1;
    Object.assign(element, { parent: null });
    f.surface.emit("frame");
    expect(f.pending.size).toBe(0);
    Object.assign(element, { parent: f.root, isDestroyed: true });
    f.surface.emit("frame");
    expect(f.pending.size).toBe(0);
    motion.dispose();
  });

  test("reduced motion and ASCII checking stay static; renderer teardown cancels callbacks", () => {
    const f = fixture();
    const motion = createSidebarMotion(f.surface, f.clock);
    const element = node({ parent: f.root });
    const frames: string[] = [];
    const entry = motion.track({ element: () => element, frame: (frame) => frames.push(frame) });
    entry.set("checking", false, true);
    expect(frames.at(-1)).toBe("⠤⠄");
    expect(f.pending.size).toBe(0);
    entry.set("checking", true);
    expect(frames.at(-1)).toBe("...");
    expect(f.pending.size).toBe(0);
    entry.set("busy", true);
    expect(frames.at(-1)).toBe("-");
    f.advance(80);
    expect(frames.at(-1)).toBe("\\");
    const count = frames.length;
    f.surface.emit("destroy");
    f.advance(800);
    entry.set("checking");
    expect(frames.length).toBe(count);
    expect(f.pending.size).toBe(0);
    expect(f.surface.listenerCount("frame")).toBe(0);
  });
});
