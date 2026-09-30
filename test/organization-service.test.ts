import { describe, expect, test } from "bun:test";
import { createOrganizationService } from "../src/organization/service";
import { organizationSessionKey } from "../src/organization/schema";
import type {
  OrganizationDocument,
  OrganizationEvent,
  OrganizationScope,
  StorageOptions,
  StoragePort,
  StorageReadResult,
  StorageWriteResult,
} from "../src/organization/types";

const scope = Object.freeze({ hostId: "server-one", projectId: "project-one" });
const user = Object.freeze({ type: "user" as const });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Expected asynchronous condition was not observed");
}

/** The fake has an atomic CAS, not a last-writer-wins set disguised as persistence. */
class MemoryStorage implements StoragePort {
  value: unknown = undefined;
  reads = 0;
  writes = 0;
  readHook?: (options?: StorageOptions) => Promise<StorageReadResult>;
  writeHook?: (
    expectedRevision: number | null,
    next: OrganizationDocument,
    options?: StorageOptions,
  ) => Promise<StorageWriteResult>;

  async read(_scope: OrganizationScope, options?: StorageOptions): Promise<StorageReadResult> {
    this.reads++;
    if (this.readHook) return this.readHook(options);
    return this.value === undefined
      ? { status: "missing" }
      : { status: "loaded", value: structuredClone(this.value) };
  }

  async compareAndSwap(
    _scope: OrganizationScope,
    expectedRevision: number | null,
    next: OrganizationDocument,
    options?: StorageOptions,
  ): Promise<StorageWriteResult> {
    this.writes++;
    if (this.writeHook) return this.writeHook(expectedRevision, next, options);
    return this.replace(expectedRevision, next);
  }

  replace(expectedRevision: number | null, next: OrganizationDocument): StorageWriteResult {
    const actual = this.value === undefined ? null : (this.value as { revision?: number }).revision;
    if (actual !== expectedRevision) return { status: "conflict" };
    this.value = structuredClone(next);
    return { status: "written", acknowledgement: "atomic-replace" };
  }
}

function pin(commandId: string, expectedRevision: number, sessionId = "alpha", pinned = true) {
  return { type: "set-pin" as const, commandId, expectedRevision, origin: user, sessionId, pinned };
}

function mark(commandId: string, expectedRevision: number, done = true) {
  return {
    type: "set-completion" as const,
    commandId,
    expectedRevision,
    origin: user,
    sessionId: "alpha",
    done,
  };
}

function add(commandId: string, expectedRevision: number, sessionId: string) {
  return { type: "add-later" as const, commandId, expectedRevision, origin: user, sessionId };
}

describe("Organization service persistence and events", () => {
  test("restart restores independent marks, pins, and Later order without replaying actions", async () => {
    const storage = new MemoryStorage();
    const service = createOrganizationService({ scope, storage });
    const events: OrganizationEvent[] = [];
    service.subscribe("observer", (event) => {
      events.push(event);
    });
    await service.start();
    expect(storage.writes).toBe(0);
    expect(await service.dispatch(pin("pin-alpha", 0))).toMatchObject({ status: "committed" });
    await service.dispatch(mark("mark-alpha", 1));
    await service.dispatch(add("later-alpha", 2, "alpha"));
    await service.dispatch(add("later-beta", 3, "beta"));
    await service.dispatch({
      type: "reorder-later",
      commandId: "order",
      expectedRevision: 4,
      origin: user,
      sessionIds: ["beta", "alpha"],
    });
    await until(() => events.length === 5);
    const before = service.snapshot().document!;
    expect(before.pins).toHaveLength(1);
    expect(before.later).toHaveLength(2);
    expect(before.completionStates).toHaveLength(1);
    expect(before.completionStates[0]?.done).toBe(true);
    expect(before.later[1]).toBe(before.pins[0]);
    service.dispose();

    const restored = createOrganizationService({ scope, storage });
    const replayed: OrganizationEvent[] = [];
    restored.subscribe("observer", (event) => {
      replayed.push(event);
    });
    await restored.start();
    await restored.refresh();
    expect(restored.snapshot().document).toEqual(before);
    expect(replayed).toEqual([]);
    expect(storage.writes).toBe(5);
    restored.dispose();
  });

  test("unchanged commands do not write or emit and stale or replayed commands cannot override", async () => {
    const storage = new MemoryStorage();
    const service = createOrganizationService({ scope, storage });
    const events: OrganizationEvent[] = [];
    service.subscribe("observer", (event) => {
      events.push(event);
    });
    await service.start();
    expect((await service.dispatch(pin("first", 0))).status).toBe("committed");
    expect((await service.dispatch(pin("same-value", 1))).status).toBe("noop");
    expect((await service.dispatch(pin("old-snapshot", 0, "alpha", false))).status).toBe("stale");
    expect((await service.dispatch(pin("first", 1, "alpha", false))).status).toBe("duplicate");
    await until(() => events.length === 1);
    expect(storage.writes).toBe(1);
    service.dispose();
    const restored = createOrganizationService({ scope, storage });
    await restored.start();
    expect((await restored.dispatch(pin("first", 1, "alpha", false))).status).toBe("duplicate");
    expect(restored.snapshot().document?.pins).toHaveLength(1);
    restored.dispose();
  });

  test("publishes immutable envelopes only after the replacement is acknowledged", async () => {
    const storage = new MemoryStorage();
    const acknowledgement = deferred<StorageWriteResult>();
    let nextDocument: OrganizationDocument | undefined;
    storage.writeHook = async (_expected, next) => {
      nextDocument = next;
      return acknowledgement.promise;
    };
    const service = createOrganizationService({ scope, storage, clock: () => "synthetic-time" });
    const events: OrganizationEvent[] = [];
    service.subscribe("observer", (event) => {
      expect(service.snapshot().document?.revision).toBe(event.revision);
      events.push(event);
    });
    await service.start();
    const initial = service.snapshot();
    const result = service.dispatch({ ...pin("input-command", 0), correlationId: "operation" });
    await until(() => nextDocument !== undefined);
    expect(service.snapshot().document?.revision).toBe(0);
    expect(events).toEqual([]);
    storage.value = structuredClone(nextDocument);
    acknowledgement.resolve({ status: "written", acknowledgement: "atomic-replace" });
    expect((await result).status).toBe("committed");
    await until(() => events.length === 1);
    expect(events[0]).toMatchObject({
      version: 1,
      type: "session.pin.changed",
      causationId: "input-command",
      correlationId: "operation",
      occurredAt: "synthetic-time",
      before: false,
      after: true,
      origin: user,
      scope,
      revision: 1,
    });
    expect(events[0]?.id).not.toBe("input-command");
    expect(Object.isFrozen(events[0])).toBe(true);
    expect(Object.isFrozen(events[0]?.scope)).toBe(true);
    expect(Object.isFrozen(events[0]?.origin)).toBe(true);
    expect(Object.isFrozen(service.snapshot().document?.pins)).toBe(true);
    expect(initial.document?.pins).toEqual([]);
    service.dispose();
  });

  test("two instances detect conflicts and refreshing does not replay another writer's event", async () => {
    const storage = new MemoryStorage();
    const first = createOrganizationService({ scope, storage });
    const second = createOrganizationService({ scope, storage });
    const events: OrganizationEvent[] = [];
    second.subscribe("observer", (event) => {
      events.push(event);
    });
    await Promise.all([first.start(), second.start()]);
    await first.dispatch(pin("first-writer", 0));
    expect((await second.dispatch(pin("second-writer", 0, "beta"))).status).toBe("conflict");
    expect(second.snapshot().phase).toBe("needs-refresh");
    await second.refresh();
    expect(second.snapshot().document?.pins).toEqual(first.snapshot().document?.pins);
    expect(events).toEqual([]);
    expect((await second.dispatch(pin("second-writer", 1, "beta"))).status).toBe("committed");
    expect(second.snapshot().document?.pins).toHaveLength(2);
    first.dispose();
    second.dispose();
  });

  test("an unknown outcome requires refresh, recovers its replay ledger, and emits no guessed event", async () => {
    const storage = new MemoryStorage();
    storage.writeHook = async (expected, next) => {
      storage.replace(expected, next);
      return { status: "unknown", message: "Acknowledgement lost after replacement" };
    };
    const service = createOrganizationService({ scope, storage });
    const events: OrganizationEvent[] = [];
    service.subscribe("observer", (event) => {
      events.push(event);
    });
    await service.start();
    expect((await service.dispatch(pin("uncertain", 0))).status).toBe("unknown");
    expect(service.snapshot().phase).toBe("needs-refresh");
    expect(service.snapshot().document?.pins).toEqual([]);
    expect((await service.dispatch(pin("premature", 0, "beta"))).status).toBe("unavailable");
    await service.refresh();
    expect(service.snapshot().document?.pins).toHaveLength(1);
    expect((await service.dispatch(pin("uncertain", 1, "alpha", false))).status).toBe("duplicate");
    expect(events).toEqual([]);
    expect(storage.writes).toBe(1);
    service.dispose();
  });

  test("a rejected replacement preserves the committed snapshot and produces no event", async () => {
    const storage = new MemoryStorage();
    const service = createOrganizationService({ scope, storage });
    const events: OrganizationEvent[] = [];
    service.subscribe("observer", (event) => {
      events.push(event);
    });
    await service.start();
    storage.writeHook = async () => ({ status: "failed", message: "Read-only store" });
    expect((await service.dispatch(pin("rejected", 0))).status).toBe("failed");
    expect(service.snapshot().document?.revision).toBe(0);
    expect(service.snapshot().document?.pins).toEqual([]);
    expect(events).toEqual([]);
    service.dispose();
  });

  test("invalid loaded state blocks mutation instead of overwriting it with empty defaults", async () => {
    const storage = new MemoryStorage();
    storage.value = { version: 999, scope, revision: 8, pins: ["must-survive"] };
    const preserved = structuredClone(storage.value);
    const service = createOrganizationService({ scope, storage });
    await service.start();
    expect(service.snapshot().phase).toBe("invalid");
    expect((await service.dispatch(pin("not-a-reset", 0))).status).toBe("unavailable");
    expect(storage.value).toEqual(preserved);
    expect(storage.writes).toBe(0);
    service.dispose();
  });

  test("disposal aborts pending storage work and suppresses a late acknowledgement", async () => {
    const storage = new MemoryStorage();
    const acknowledgement = deferred<StorageWriteResult>();
    let signal: AbortSignal | undefined;
    storage.writeHook = async (_expected, _next, options) => {
      signal = options?.signal;
      return acknowledgement.promise;
    };
    const service = createOrganizationService({ scope, storage });
    const events: OrganizationEvent[] = [];
    service.subscribe("observer", (event) => {
      events.push(event);
    });
    await service.start();
    const result = service.dispatch(pin("pending", 0));
    await until(() => signal !== undefined);
    service.dispose();
    expect(signal?.aborted).toBe(true);
    acknowledgement.resolve({ status: "written", acknowledgement: "atomic-replace" });
    expect((await result).status).toBe("unknown");
    expect(service.snapshot().phase).toBe("disposed");
    expect(events).toEqual([]);
    expect((await service.dispatch(pin("after-dispose", 0))).status).toBe("disposed");
  });

  test("serializes queued writes and captures mutable commands before asynchronous work", async () => {
    const storage = new MemoryStorage();
    const mutableScope: { hostId: string; projectId: string } = { ...scope };
    const service = createOrganizationService({ scope: mutableScope, storage });
    mutableScope.hostId = "changed-after-construction";
    await service.start();
    const command = pin("captured", 0);
    const first = service.dispatch(command);
    command.sessionId = "changed-after-dispatch";
    command.pinned = false;
    const second = service.dispatch(pin("stale-queued", 0, "beta"));
    expect((await first).status).toBe("committed");
    expect((await second).status).toBe("stale");
    expect(service.snapshot().document?.scope).toEqual(scope);
    expect(service.snapshot().document?.pins).toEqual([organizationSessionKey(scope, "alpha")]);
    expect(storage.writes).toBe(1);
    service.dispose();
  });

  test("extension commands do not deadlock or recursively trigger extension observers", async () => {
    const storage = new MemoryStorage();
    const service = createOrganizationService({ scope, storage });
    const finished = deferred<string>();
    const seen: OrganizationEvent[] = [];
    service.subscribe("follow-up", async (event, context) => {
      seen.push(event);
      const result = await context.dispatch({
        type: "set-completion",
        commandId: "follow-up-mark",
        sessionId: "alpha",
        done: true,
      });
      finished.resolve(result.status);
    });
    await service.start();
    expect((await service.dispatch(pin("user-pin", 0))).status).toBe("committed");
    expect(await finished.promise).toBe("committed");
    expect(service.snapshot().document?.revision).toBe(2);
    expect(service.snapshot().document?.completionStates[0]?.done).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.origin).toEqual(user);
    service.dispose();
  });

  test("a delayed extension result retains its event revision and cannot overwrite a newer decision", async () => {
    const storage = new MemoryStorage();
    const service = createOrganizationService({ scope, storage });
    const started = deferred<void>();
    const resume = deferred<void>();
    const outcome = deferred<string>();
    service.subscribe("delayed-follow-up", async (event, context) => {
      if (event.causationId !== "first") return;
      started.resolve();
      await resume.promise;
      outcome.resolve(
        (
          await context.dispatch({
            type: "set-pin",
            commandId: "late-result",
            sessionId: "alpha",
            pinned: true,
          })
        ).status,
      );
    });
    await service.start();
    await service.dispatch(pin("first", 0));
    await started.promise;
    await service.dispatch(pin("newer-choice", 1, "alpha", false));
    resume.resolve();
    expect(await outcome.promise).toBe("stale");
    expect(service.snapshot().document?.pins).toEqual([]);
    expect(service.snapshot().document?.revision).toBe(2);
    service.dispose();
  });

  test("subscriber failure and timeout do not delay commits or other observers", async () => {
    const storage = new MemoryStorage();
    const service = createOrganizationService({
      scope,
      storage,
      limits: { listenerTimeoutMs: 15 },
    });
    const blocked = deferred<void>();
    let slowSignal: AbortSignal | undefined;
    let slowCalls = 0;
    const healthy: OrganizationEvent[] = [];
    service.subscribe("broken", async () => {
      throw new Error("Extension failure");
    });
    service.subscribe("slow", async (_event, context) => {
      slowCalls++;
      slowSignal = context.signal;
      await blocked.promise;
    });
    const unsubscribe = service.subscribe("healthy", (event) => {
      healthy.push(event);
    });
    await service.start();
    expect((await service.dispatch(pin("first", 0))).status).toBe("committed");
    await until(() => healthy.length === 1 && slowSignal?.aborted === true);
    expect((await service.dispatch(pin("second", 1, "beta"))).status).toBe("committed");
    await until(() => healthy.length === 2);
    expect(slowCalls).toBe(1);
    expect(service.snapshot().listenerTimeouts).toBe(1);
    expect(service.snapshot().listenerFailures).toBeGreaterThanOrEqual(1);
    expect(service.snapshot().document?.pins).toHaveLength(2);
    unsubscribe();
    unsubscribe();
    await service.dispatch(pin("third", 2, "gamma"));
    expect(healthy).toHaveLength(2);
    service.dispose();
    blocked.resolve();
  });

  test("storage timeout marks the outcome unknown and late resolution cannot publish a commit", async () => {
    const storage = new MemoryStorage();
    const pending = deferred<StorageWriteResult>();
    let signal: AbortSignal | undefined;
    storage.writeHook = async (_expected, _next, options) => {
      signal = options?.signal;
      return pending.promise;
    };
    const service = createOrganizationService({ scope, storage, limits: { storageTimeoutMs: 15 } });
    const events: OrganizationEvent[] = [];
    service.subscribe("observer", (event) => {
      events.push(event);
    });
    await service.start();
    expect((await service.dispatch(pin("timed-out", 0))).status).toBe("unknown");
    expect(signal?.aborted).toBe(true);
    expect(service.snapshot().phase).toBe("needs-refresh");
    pending.resolve({ status: "written", acknowledgement: "atomic-replace" });
    await Promise.resolve();
    expect(service.snapshot().document?.revision).toBe(0);
    expect(events).toEqual([]);
    service.dispose();
  });

  test("migration is an explicit acknowledged write and does not replay imported annotations", async () => {
    const storage = new MemoryStorage();
    const alpha = organizationSessionKey(scope, "alpha");
    const beta = organizationSessionKey(scope, "beta");
    storage.value = {
      version: 0,
      scope,
      revision: 3,
      pins: [alpha],
      later: [beta, alpha],
      completed: [alpha],
    };
    const legacy = structuredClone(storage.value);
    const service = createOrganizationService({ scope, storage });
    const events: OrganizationEvent[] = [];
    service.subscribe("observer", (event) => {
      events.push(event);
    });
    await service.start();
    expect(service.snapshot().phase).toBe("migration-required");
    expect(storage.writes).toBe(0);
    expect(storage.value).toEqual(legacy);
    expect((await service.dispatch(pin("blocked-until-migration", 3))).status).toBe("unavailable");
    expect(
      (await service.migrate({ commandId: "migrate", expectedRevision: 3, origin: user })).status,
    ).toBe("committed");
    expect(service.snapshot().phase).toBe("ready");
    expect(service.snapshot().document).toMatchObject({
      version: 1,
      revision: 4,
      pins: [alpha],
      later: [beta, alpha],
      unreconciled: [alpha],
    });
    expect(service.snapshot().document?.completionStates[0]).toMatchObject({
      sessionKey: alpha,
      done: true,
    });
    expect(events).toEqual([]);
    expect(storage.writes).toBe(1);
    service.dispose();
  });

  test("a timed-out storage port cannot accumulate unresolved work across repeated refreshes", async () => {
    const storage = new MemoryStorage();
    const heldRead = deferred<StorageReadResult>();
    storage.readHook = async () => heldRead.promise;
    const service = createOrganizationService({ scope, storage, limits: { storageTimeoutMs: 10 } });
    await service.start();
    expect(service.snapshot().phase).toBe("needs-refresh");
    for (let attempt = 0; attempt < 5; attempt++) await service.refresh();
    expect(storage.reads).toBe(1);
    expect(service.snapshot().document).toBeNull();
    heldRead.resolve({ status: "missing" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await service.refresh();
    expect(storage.reads).toBe(2);
    expect(service.snapshot().phase).toBe("ready");
    service.dispose();
  });

  test("unsubscribing a timed-out noncooperative listener cannot free its outstanding work budget", async () => {
    const storage = new MemoryStorage();
    const service = createOrganizationService({
      scope,
      storage,
      limits: { maxPendingDeliveries: 1, listenerTimeoutMs: 10 },
    });
    const heldListener = deferred<void>();
    const unsubscribe = service.subscribe("noncooperative", async () => heldListener.promise);
    await service.start();
    await service.dispatch(pin("first", 0));
    await until(() => service.snapshot().listenerTimeouts === 1);
    expect(service.snapshot().pendingDeliveries).toBe(1);
    unsubscribe();
    let replacementCalls = 0;
    service.subscribe("replacement", () => {
      replacementCalls++;
    });
    await service.dispatch(pin("second", 1, "beta"));
    expect(replacementCalls).toBe(0);
    expect(service.snapshot().droppedDeliveries).toBe(1);
    expect(service.snapshot().pendingDeliveries).toBe(1);
    heldListener.resolve();
    await until(() => service.snapshot().pendingDeliveries === 0);
    await service.dispatch(pin("third", 2, "gamma"));
    await until(() => replacementCalls === 1);
    service.dispose();
  });

  test("bounds queued commands while allowing already admitted writes to finish in revision order", async () => {
    const storage = new MemoryStorage();
    const heldWrite = deferred<void>();
    storage.writeHook = async (expected, next) => {
      await heldWrite.promise;
      return storage.replace(expected, next);
    };
    const service = createOrganizationService({
      scope,
      storage,
      limits: { maxPendingCommands: 2 },
    });
    await service.start();
    const first = service.dispatch(pin("first", 0));
    await until(() => storage.writes === 1);
    const second = service.dispatch(pin("second", 1, "beta"));
    expect((await service.dispatch(pin("overflow", 2, "gamma"))).status).toBe("busy");
    expect(service.snapshot().pendingCommands).toBe(2);
    heldWrite.resolve();
    expect((await first).status).toBe("committed");
    expect((await second).status).toBe("committed");
    expect(service.snapshot().document?.revision).toBe(2);
    expect(service.snapshot().pendingCommands).toBe(0);
    expect(storage.writes).toBe(2);
    service.dispose();
  });

  test("captures Later order inputs and rejects membership-changing reorders without persistence", async () => {
    const storage = new MemoryStorage();
    const service = createOrganizationService({ scope, storage });
    await service.start();
    await service.dispatch(add("alpha", 0, "alpha"));
    await service.dispatch(add("beta", 1, "beta"));
    const order = ["beta", "alpha"];
    const reorder = service.dispatch({
      type: "reorder-later",
      commandId: "reorder",
      expectedRevision: 2,
      origin: user,
      sessionIds: order,
    });
    order.reverse();
    expect((await reorder).status).toBe("committed");
    const document = service.snapshot().document!;
    expect(document.later).toEqual([
      organizationSessionKey(scope, "beta"),
      organizationSessionKey(scope, "alpha"),
    ]);
    expect(
      (
        await service.dispatch({
          type: "reorder-later",
          commandId: "drop-session",
          expectedRevision: 3,
          origin: user,
          sessionIds: ["alpha"],
        })
      ).status,
    ).toBe("invalid");
    expect(service.snapshot().document).toEqual(document);
    expect(storage.writes).toBe(3);
    service.dispose();
  });

  test("a legacy document whose expanded migration exceeds the format limit stays recoverable", async () => {
    const storage = new MemoryStorage();
    storage.value = {
      version: 0,
      scope,
      revision: 0,
      pins: [],
      later: [],
      completed: Array.from({ length: 5_000 }, (_, index) =>
        organizationSessionKey(scope, "x".repeat(100) + index),
      ),
    };
    const legacy = structuredClone(storage.value);
    const service = createOrganizationService({ scope, storage });
    await service.start();
    expect(service.snapshot().phase).toBe("migration-required");
    expect(
      (
        await service.migrate({
          commandId: "expanded-migration",
          expectedRevision: 0,
          origin: user,
        })
      ).status,
    ).toBe("invalid");
    expect(storage.writes).toBe(0);
    expect(storage.value).toEqual(legacy);
    expect(service.snapshot().phase).toBe("migration-required");
    service.dispose();
  });

  test("a newer confirmed frontier persists without a visual event and rejects stale mark results", async () => {
    const storage = new MemoryStorage();
    const service = createOrganizationService({ scope, storage });
    const events: OrganizationEvent[] = [];
    service.subscribe("observer", (event) => {
      events.push(event);
    });
    await service.start();
    expect(
      (await service.dispatch({ ...mark("mark-at-five", 0), executionSequence: 5 })).status,
    ).toBe("committed");
    await until(() => events.length === 1);
    expect(
      (await service.dispatch({ ...mark("observe-seven", 1), executionSequence: 7 })).status,
    ).toBe("committed");
    expect(service.snapshot().document?.revision).toBe(2);
    expect(service.snapshot().document?.completionStates[0]).toMatchObject({
      done: true,
      executionSequence: 7,
      revision: 1,
      markEventId: "mark-at-five",
    });
    expect(events).toHaveLength(1);
    expect(
      (await service.dispatch({ ...mark("late-clear", 2, false), executionSequence: 6 })).status,
    ).toBe("stale");
    expect(storage.writes).toBe(2);
    expect(
      (await service.dispatch({ ...mark("current-clear", 2, false), executionSequence: 7 })).status,
    ).toBe("committed");
    await until(() => events.length === 2);
    expect(events[1]).toMatchObject({
      type: "session.completion.changed",
      revision: 3,
      completionRevision: 2,
      before: true,
      after: false,
    });
    service.dispose();
    const restored = createOrganizationService({ scope, storage });
    await restored.start();
    expect(restored.snapshot().document?.completionStates[0]).toMatchObject({
      done: false,
      executionSequence: 7,
    });
    expect(
      (await restored.dispatch({ ...mark("old-after-restart", 3), executionSequence: 5 })).status,
    ).toBe("stale");
    restored.dispose();
  });

  test("an imported mark cannot be silently reconciled with unproven execution history", async () => {
    const storage = new MemoryStorage();
    const alpha = organizationSessionKey(scope, "alpha");
    storage.value = { version: 0, scope, revision: 0, pins: [], later: [], completed: [alpha] };
    const service = createOrganizationService({ scope, storage });
    await service.start();
    await service.migrate({ commandId: "migrate", expectedRevision: 0, origin: user });
    expect(
      (await service.dispatch({ ...mark("invent-frontier", 1), executionSequence: 7 })).status,
    ).toBe("invalid");
    expect(service.snapshot().document?.unreconciled).toEqual([alpha]);
    expect(storage.writes).toBe(1);
    expect((await service.dispatch(mark("explicit-clear", 1, false))).status).toBe("committed");
    expect(service.snapshot().document?.unreconciled).toEqual([]);
    expect(service.snapshot().document?.completionStates[0]?.done).toBe(false);
    service.dispose();
  });
});
