import { describe, expect, test } from "bun:test";
import { addToQueue, createQueue, removeFromQueue, reorderQueue } from "../src/core";

describe("Later organization", () => {
  test("restores unique entries in insertion order and retains separate host identities", () => {
    expect(createQueue(["server-a/session-1", "server-b/session-1", "server-a/session-1"])).toEqual(
      ["server-a/session-1", "server-b/session-1"],
    );
  });

  test("adding and removing are immutable, ordered, and idempotent", () => {
    const initial = Object.freeze(["first", "second"]);
    const added = addToQueue(initial, "third");
    expect(added.queue).toEqual(["first", "second", "third"]);
    expect(initial).toEqual(["first", "second"]);
    expect(added.change).toMatchObject({ action: "added", sessionKey: "third" });
    const duplicate = addToQueue(added.queue, "third");
    expect(duplicate.queue).toBe(added.queue);
    expect(duplicate.change).toBeUndefined();

    const removed = removeFromQueue(added.queue, "second");
    expect(removed.queue).toEqual(["first", "third"]);
    expect(removed.change).toMatchObject({ action: "removed", sessionKey: "second" });
    const missing = removeFromQueue(removed.queue, "second");
    expect(missing.queue).toBe(removed.queue);
    expect(missing.change).toBeUndefined();
  });

  test("reordering is an explicit complete permutation and preserves input snapshots", () => {
    const queue = Object.freeze(["one", "two", "three"]);
    const requested = ["three", "one", "two"];
    const result = reorderQueue(queue, requested);
    requested.reverse();
    expect(result.queue).toEqual(["three", "one", "two"]);
    expect(queue).toEqual(["one", "two", "three"]);
    expect(result.change).toMatchObject({
      action: "reordered",
      before: queue,
      after: result.queue,
    });
    expect(reorderQueue(result.queue, ["three", "one", "two"])).toEqual({ queue: result.queue });
    expect(reorderQueue(result.queue, result.queue).queue).toBe(result.queue);
  });

  test("invalid reorder requests cannot add, drop, or duplicate sessions", () => {
    const queue = createQueue(["one", "two", "three"]);
    for (const invalid of [
      ["one", "two"],
      ["one", "two", "four"],
      ["one", "one", "two"],
    ]) {
      expect(() => reorderQueue(queue, invalid)).toThrow(RangeError);
    }
    expect(queue).toEqual(["one", "two", "three"]);
  });

  test("returned queue and change snapshots cannot be rewritten through mutable inputs", () => {
    const input = ["one", "two"];
    const requested = ["two", "one"];
    const result = reorderQueue(input, requested);
    input[0] = "changed";
    requested.pop();
    expect(result.change?.before).toEqual(["one", "two"]);
    expect(result.change?.after).toEqual(["two", "one"]);
    expect(result.queue).toEqual(["two", "one"]);
    expect(Object.isFrozen(result.queue)).toBe(true);
    expect(Object.isFrozen(result.change?.before)).toBe(true);
    expect(Object.isFrozen(result.change?.after)).toBe(true);

    const mutable = ["first"];
    const noop = addToQueue(mutable, "first");
    mutable.push("second");
    expect(noop.queue).toEqual(["first"]);
    expect(noop.change).toBeUndefined();
    expect(Object.isFrozen(noop.queue)).toBe(true);
  });
});
