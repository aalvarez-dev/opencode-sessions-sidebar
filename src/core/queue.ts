import type { QueueChange, QueueResult, SessionKey } from "./types";

function assertKey(key: SessionKey): void {
  if (key.length === 0) throw new RangeError("Session keys must not be empty");
}

function assertQueue(queue: readonly SessionKey[]): void {
  for (const key of queue) assertKey(key);
  if (new Set(queue).size !== queue.length) {
    throw new RangeError("Queue must contain unique session keys");
  }
}

function snapshot(queue: readonly SessionKey[]): readonly SessionKey[] {
  return Object.isFrozen(queue) ? queue : Object.freeze([...queue]);
}

/** Restores an ordered unique list, preserving each key's first occurrence. */
export function createQueue(keys: readonly SessionKey[] = []): readonly SessionKey[] {
  for (const key of keys) assertKey(key);
  return Object.freeze([...new Set(keys)]);
}

function changed(
  before: readonly SessionKey[],
  after: readonly SessionKey[],
  action: QueueChange["action"],
  sessionKey?: SessionKey,
): QueueResult {
  const previous = snapshot(before);
  const next = snapshot(after);
  return {
    queue: next,
    change: Object.freeze({
      type: "queue.changed",
      action,
      before: previous,
      after: next,
      ...(sessionKey === undefined ? {} : { sessionKey }),
    }),
  };
}

/** Organization only: no runner, completion changes, pin changes, or navigation. */
export function addToQueue(queue: readonly SessionKey[], sessionKey: SessionKey): QueueResult {
  assertQueue(queue);
  assertKey(sessionKey);
  if (queue.includes(sessionKey)) return { queue: snapshot(queue) };
  return changed(queue, [...queue, sessionKey], "added", sessionKey);
}

export function removeFromQueue(queue: readonly SessionKey[], sessionKey: SessionKey): QueueResult {
  assertQueue(queue);
  assertKey(sessionKey);
  if (!queue.includes(sessionKey)) return { queue: snapshot(queue) };
  return changed(
    queue,
    queue.filter((key) => key !== sessionKey),
    "removed",
    sessionKey,
  );
}

/** Requires a complete permutation; reordering cannot silently add or drop work. */
export function reorderQueue(
  queue: readonly SessionKey[],
  orderedKeys: readonly SessionKey[],
): QueueResult {
  assertQueue(queue);
  assertQueue(orderedKeys);
  const existing = new Set(queue);
  if (queue.length !== orderedKeys.length || orderedKeys.some((key) => !existing.has(key))) {
    throw new RangeError("Reordering must contain each queued session exactly once");
  }
  if (queue.every((key, index) => key === orderedKeys[index])) return { queue: snapshot(queue) };
  return changed(queue, [...orderedKeys], "reordered");
}
