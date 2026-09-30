import {
  addToQueue,
  createCompletionState,
  removeFromQueue,
  reorderQueue,
  setCompletion,
} from "../core";
import type { EventOrigin } from "../core";
import {
  createOrganizationDocument,
  decodeOrganizationDocument,
  migrateOrganizationV0,
  ORGANIZATION_LIMITS,
  organizationSessionKey,
  validateOrganizationScope,
} from "./schema";
import type {
  LegacyOrganizationDocumentV0,
  OrganizationDocument,
  OrganizationEvent,
  OrganizationScope,
  StoragePort,
  StorageReadResult,
  StorageWriteResult,
} from "./types";

export interface OrganizationCommandContext {
  readonly commandId: string;
  readonly expectedRevision: number;
  readonly origin: EventOrigin;
  readonly correlationId?: string;
}
export type OrganizationAction =
  | { readonly type: "set-pin"; readonly sessionId: string; readonly pinned: boolean }
  | {
      readonly type: "set-completion";
      readonly sessionId: string;
      readonly done: boolean;
      readonly executionSequence?: number;
    }
  | { readonly type: "add-later" | "remove-later"; readonly sessionId: string }
  | { readonly type: "reorder-later"; readonly sessionIds: readonly string[] };
export type OrganizationCommand = OrganizationCommandContext & OrganizationAction;
export type BoundOrganizationCommand = Omit<
  OrganizationCommandContext,
  "origin" | "expectedRevision"
> &
  OrganizationAction;
export interface OrganizationResult {
  readonly status:
    | "committed"
    | "noop"
    | "stale"
    | "duplicate"
    | "conflict"
    | "failed"
    | "unknown"
    | "invalid"
    | "unavailable"
    | "disposed"
    | "busy";
  readonly revision: number | null;
  readonly message?: string;
}
export interface OrganizationLimits {
  readonly maxPendingCommands: number;
  readonly maxSubscribers: number;
  readonly maxPendingDeliveries: number;
  readonly listenerTimeoutMs: number;
  readonly storageTimeoutMs: number;
}
export interface OrganizationSnapshot {
  readonly phase:
    | "idle"
    | "loading"
    | "ready"
    | "migration-required"
    | "invalid"
    | "needs-refresh"
    | "disposed";
  readonly document: OrganizationDocument | null;
  readonly diagnostic: string | null;
  readonly pendingCommands: number;
  readonly subscribers: number;
  readonly pendingDeliveries: number;
  readonly pendingStorageOperations: number;
  readonly listenerFailures: number;
  readonly listenerTimeouts: number;
  readonly droppedDeliveries: number;
}
export interface OrganizationListenerContext {
  readonly signal: AbortSignal;
  /** Bound to the event's observed revision and the registered extension identity. */
  dispatch(command: BoundOrganizationCommand): Promise<OrganizationResult>;
}
export type OrganizationListener = (
  event: OrganizationEvent,
  context: OrganizationListenerContext,
) => void | Promise<void>;
export interface OrganizationServiceOptions {
  readonly scope: OrganizationScope;
  readonly storage: StoragePort;
  /** Diagnostic time only. Never used for ordering, causality, or conflict resolution. */
  readonly clock?: () => string;
  readonly limits?: Partial<OrganizationLimits>;
}

type EventBody = OrganizationEvent extends infer E
  ? E extends OrganizationEvent
    ? Omit<
        E,
        | "version"
        | "id"
        | "scope"
        | "revision"
        | "origin"
        | "causationId"
        | "correlationId"
        | "occurredAt"
      >
    : never
  : never;
interface Subscriber {
  readonly id: string;
  readonly handler: OrganizationListener;
  active: boolean;
  controller: AbortController | null;
}
interface Delivery {
  readonly subscriber: Subscriber;
  readonly event: OrganizationEvent;
}
const defaults: OrganizationLimits = {
  maxPendingCommands: 64,
  maxSubscribers: 64,
  maxPendingDeliveries: 256,
  listenerTimeoutMs: 1_000,
  storageTimeoutMs: 10_000,
};

function id(
  value: unknown,
  max: number = ORGANIZATION_LIMITS.maxIdLength,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > max)
    throw new RangeError("Invalid identifier");
}
function contextValid(context: OrganizationCommandContext): void {
  id(context.commandId, ORGANIZATION_LIMITS.maxEventIdLength);
  if (!Number.isSafeInteger(context.expectedRevision) || context.expectedRevision < 0)
    throw new RangeError("Invalid expected document revision");
  if (context.correlationId !== undefined)
    id(context.correlationId, ORGANIZATION_LIMITS.maxEventIdLength);
  if (!context.origin || !["user", "host", "extension", "unknown"].includes(context.origin.type))
    throw new RangeError("Invalid command origin");
  if (context.origin.type === "extension") id(context.origin.id);
}
function commandValid(command: OrganizationCommand): void {
  contextValid(command);
  if (command.type === "reorder-later") {
    if (
      !Array.isArray(command.sessionIds) ||
      command.sessionIds.length > ORGANIZATION_LIMITS.maxEntries
    )
      throw new RangeError("Invalid Later order");
    command.sessionIds.forEach((value) => id(value));
  } else {
    id(command.sessionId);
    if (command.type === "set-pin") {
      if (typeof command.pinned !== "boolean") throw new RangeError("Invalid pin value");
    } else if (command.type === "set-completion") {
      if (typeof command.done !== "boolean") throw new RangeError("Invalid completion value");
      if (
        command.executionSequence !== undefined &&
        (!Number.isSafeInteger(command.executionSequence) || command.executionSequence < 0)
      )
        throw new RangeError("Invalid execution sequence");
    } else if (command.type !== "add-later" && command.type !== "remove-later")
      throw new RangeError("Unknown organization command");
  }
}

/** Manual annotations and best-effort post-acknowledgement events. No host execution is started. */
export function createOrganizationService(options: OrganizationServiceOptions) {
  const scope = validateOrganizationScope(options.scope);
  const storage = options.storage;
  const clock = options.clock;
  const limits = Object.freeze({ ...defaults, ...options.limits });
  for (const value of Object.values(limits))
    if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647)
      throw new RangeError("Limits must be positive safe timer-compatible integers");
  let phase: OrganizationSnapshot["phase"] = "idle";
  let document: OrganizationDocument | null = null;
  let legacy: LegacyOrganizationDocumentV0 | null = null;
  let expectedStorageRevision: number | null = null;
  let diagnostic: string | null = null;
  let pendingCommands = 0;
  let chain = Promise.resolve();
  let listenerFailures = 0;
  let listenerTimeouts = 0;
  let droppedDeliveries = 0;
  let pumping = false;
  let storageInFlight = false;
  const subscribers = new Map<string, Subscriber>();
  const deliveries: Delivery[] = [];
  const controllers = new Set<AbortController>();
  const activeDeliveries = new Set<Subscriber>();
  const disposed = () => phase === "disposed";
  const revision = () => document?.revision ?? legacy?.revision ?? null;
  const result = (status: OrganizationResult["status"], message?: string): OrganizationResult =>
    Object.freeze({ status, revision: revision(), ...(message === undefined ? {} : { message }) });
  const snapshot = (): OrganizationSnapshot =>
    Object.freeze({
      phase,
      document,
      diagnostic,
      pendingCommands,
      subscribers: subscribers.size,
      pendingDeliveries: deliveries.length + activeDeliveries.size,
      pendingStorageOperations: Number(storageInFlight),
      listenerFailures,
      listenerTimeouts,
      droppedDeliveries,
    });

  function enqueue<T>(operation: () => Promise<T>, rejected: () => T): Promise<T> {
    if (disposed() || pendingCommands >= limits.maxPendingCommands)
      return Promise.resolve(rejected());
    pendingCommands += 1;
    const task = chain.then(operation);
    chain = task.then(
      () => undefined,
      () => undefined,
    );
    return task.finally(() => {
      pendingCommands -= 1;
    });
  }

  async function bounded<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    cancelled: T,
    signal?: AbortSignal,
  ): Promise<T> {
    if (disposed() || signal?.aborted || storageInFlight) return cancelled;
    const controller = new AbortController();
    controllers.add(controller);
    storageInFlight = true;
    let cancel!: () => void;
    const interrupted = new Promise<T>((resolve) => {
      cancel = () => {
        controller.abort();
        resolve(cancelled);
      };
    });
    signal?.addEventListener("abort", cancel, { once: true });
    // The service's dispose path aborts the controller independently.
    const onAbort = () => cancel();
    controller.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(cancel, limits.storageTimeoutMs);
    const work = Promise.resolve()
      .then(() => (controller.signal.aborted ? cancelled : operation(controller.signal)))
      .finally(() => {
        storageInFlight = false;
        controllers.delete(controller);
      });
    try {
      return await Promise.race([work, interrupted]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      controller.signal.removeEventListener("abort", onAbort);
      controller.abort();
    }
  }

  function scheduleDeliveries(): void {
    if (pumping || disposed()) return;
    pumping = true;
    queueMicrotask(() => {
      pumping = false;
      if (disposed()) return;
      for (let index = 0; index < deliveries.length; ) {
        const delivery = deliveries[index]!;
        const subscriber = delivery.subscriber;
        if (!subscriber.active) {
          deliveries.splice(index, 1);
          continue;
        }
        if (activeDeliveries.has(subscriber)) {
          index += 1;
          continue;
        }
        deliveries.splice(index, 1);
        activeDeliveries.add(subscriber);
        const controller = new AbortController();
        subscriber.controller = controller;
        let timedOut = false;
        let finish!: () => void;
        const stopped = new Promise<void>((resolve) => {
          finish = resolve;
        });
        controller.signal.addEventListener("abort", finish, { once: true });
        const timer = setTimeout(() => {
          timedOut = true;
          subscriber.active = false;
          if (subscribers.get(subscriber.id) === subscriber) subscribers.delete(subscriber.id);
          for (let pending = deliveries.length - 1; pending >= 0; pending -= 1)
            if (deliveries[pending]!.subscriber === subscriber) deliveries.splice(pending, 1);
          controller.abort();
        }, limits.listenerTimeoutMs);
        const context: OrganizationListenerContext = Object.freeze({
          signal: controller.signal,
          dispatch: (command: BoundOrganizationCommand) =>
            dispatch(
              {
                ...command,
                expectedRevision: delivery.event.revision,
                origin: { type: "extension", id: subscriber.id },
              },
              controller.signal,
            ),
        });
        const handled = Promise.resolve()
          .then(() => {
            if (!controller.signal.aborted && subscriber.active && !disposed())
              return subscriber.handler(delivery.event, context);
          })
          .catch(() => {
            if (!controller.signal.aborted) listenerFailures += 1;
          })
          .finally(() => {
            // Timeouts revoke the command context, but cannot stop arbitrary extension work.
            // Reserve capacity until the actual handler settles, even after unsubscribe.
            activeDeliveries.delete(subscriber);
            scheduleDeliveries();
          });
        void Promise.race([handled, stopped]).finally(() => {
          clearTimeout(timer);
          controller.signal.removeEventListener("abort", finish);
          controller.abort();
          if (timedOut) listenerTimeouts += 1;
          if (subscriber.controller === controller) subscriber.controller = null;
          scheduleDeliveries();
        });
      }
    });
  }
  function publish(events: readonly OrganizationEvent[]): void {
    for (const event of events) {
      // Reactions never recursively react to extension mutations in this experimental surface.
      if (event.origin.type === "extension") continue;
      for (const subscriber of subscribers.values()) {
        if (deliveries.length + activeDeliveries.size >= limits.maxPendingDeliveries) {
          droppedDeliveries += 1;
          continue;
        }
        deliveries.push({ subscriber, event });
      }
    }
    scheduleDeliveries();
  }
  function subscribe(extensionId: string, handler: OrganizationListener): () => void {
    id(extensionId);
    if (disposed()) throw new Error("Organization service is disposed");
    if (typeof handler !== "function") throw new TypeError("Listener must be a function");
    if (subscribers.has(extensionId)) throw new Error("Extension identity already subscribed");
    if (subscribers.size >= limits.maxSubscribers) throw new RangeError("Subscriber limit reached");
    const subscriber: Subscriber = { id: extensionId, handler, active: true, controller: null };
    subscribers.set(extensionId, subscriber);
    return () => {
      if (!subscriber.active) return;
      subscriber.active = false;
      subscriber.controller?.abort();
      subscribers.delete(extensionId);
      for (let index = deliveries.length - 1; index >= 0; index -= 1)
        if (deliveries[index]!.subscriber === subscriber) deliveries.splice(index, 1);
    };
  }

  async function read(): Promise<OrganizationSnapshot> {
    if (disposed()) return snapshot();
    phase = "loading";
    let readResult: StorageReadResult;
    try {
      readResult = await bounded((signal) => storage.read(scope, { signal }), {
        status: "failed",
        message: "Storage read unavailable, interrupted, or timed out",
      } as StorageReadResult);
    } catch {
      readResult = { status: "failed", message: "Storage read failed" };
    }
    if (disposed()) return snapshot();
    diagnostic = null;
    if (readResult.status === "missing") {
      document = createOrganizationDocument(scope);
      legacy = null;
      expectedStorageRevision = null;
      phase = "ready";
    } else if (readResult.status === "failed") {
      phase = "needs-refresh";
      diagnostic = readResult.message;
    } else {
      const decoded = decodeOrganizationDocument(readResult.value, scope);
      if (decoded.status === "valid") {
        document = decoded.document;
        legacy = null;
        expectedStorageRevision = document.revision;
        phase = "ready";
      } else if (decoded.status === "migration-required") {
        document = null;
        legacy = decoded.legacy;
        expectedStorageRevision = legacy.revision;
        phase = "migration-required";
      } else {
        document = null;
        legacy = null;
        phase = "invalid";
        diagnostic = decoded.message;
      }
    }
    return snapshot();
  }
  const refresh = () => enqueue(read, snapshot);
  const start = () =>
    enqueue(
      () =>
        phase === "ready" || phase === "migration-required" || phase === "invalid"
          ? Promise.resolve(snapshot())
          : read(),
      snapshot,
    );

  function guard(context: OrganizationCommandContext): OrganizationResult | undefined {
    if (document?.recentCommandIds.includes(context.commandId)) return result("duplicate");
    if (context.expectedRevision !== revision()) return result("stale");
    if (revision() === Number.MAX_SAFE_INTEGER)
      return result("invalid", "Document revision exhausted");
    return undefined;
  }
  function envelope(
    body: EventBody,
    context: OrganizationCommandContext,
    nextRevision: number,
  ): OrganizationEvent {
    let occurredAt: string | undefined;
    try {
      occurredAt = clock?.();
    } catch {
      /* A diagnostic clock cannot prevent a committed mutation. */
    }
    return Object.freeze({
      ...body,
      version: 1,
      id: JSON.stringify([scope.hostId, scope.projectId, context.commandId, nextRevision, 0]),
      scope,
      revision: nextRevision,
      origin: Object.freeze(
        context.origin.type === "extension"
          ? { type: "extension", id: context.origin.id }
          : { type: context.origin.type },
      ),
      causationId: context.commandId,
      ...(context.correlationId === undefined ? {} : { correlationId: context.correlationId }),
      ...(typeof occurredAt === "string" ? { occurredAt } : {}),
    }) as OrganizationEvent;
  }
  async function commit(
    next: OrganizationDocument,
    context: OrganizationCommandContext,
    body?: EventBody,
    signal?: AbortSignal,
  ): Promise<OrganizationResult> {
    const decoded = decodeOrganizationDocument(next, scope);
    if (decoded.status !== "valid")
      return result("invalid", "Result exceeds the storage schema limits");
    let outcome: StorageWriteResult;
    try {
      outcome = await bounded(
        (operationSignal) =>
          storage.compareAndSwap(scope, expectedStorageRevision, decoded.document, {
            signal: operationSignal,
          }),
        {
          status: "unknown",
          message: "Storage write unavailable, interrupted, or timed out",
        } as StorageWriteResult,
        signal,
      );
    } catch {
      outcome = { status: "unknown", message: "Storage write threw without a confirmed outcome" };
    }
    if (
      !outcome ||
      !["written", "conflict", "failed", "unknown"].includes(outcome.status) ||
      (outcome.status === "written" && outcome.acknowledgement !== "atomic-replace")
    ) {
      outcome = { status: "unknown", message: "Storage returned no supported acknowledgement" };
    }
    if (disposed())
      return result("unknown", "Operation outlived the coordinator; storage may have changed");
    if (signal?.aborted || outcome.status !== "written") {
      phase = "needs-refresh";
      diagnostic = signal?.aborted
        ? "Operation cancelled; refresh required"
        : outcome.status === "conflict"
          ? "Concurrent edit detected; refresh required"
          : outcome.status === "written"
            ? "Refresh required"
            : outcome.message;
      return result(
        signal?.aborted ? "unknown" : outcome.status === "written" ? "unknown" : outcome.status,
        diagnostic,
      );
    }
    document = decoded.document;
    legacy = null;
    expectedStorageRevision = document.revision;
    phase = "ready";
    diagnostic = outcome.diagnostic ?? null;
    if (body) publish([envelope(body, context, document.revision)]);
    return result("committed");
  }
  function nextDocument(
    base: OrganizationDocument,
    context: OrganizationCommandContext,
  ): OrganizationDocument {
    return {
      ...base,
      revision: base.revision + 1,
      recentCommandIds: [...base.recentCommandIds, context.commandId].slice(
        -ORGANIZATION_LIMITS.maxRecentCommandIds,
      ),
    };
  }
  function dispatch(input: OrganizationCommand, signal?: AbortSignal): Promise<OrganizationResult> {
    let command: OrganizationCommand;
    try {
      command = structuredClone(input);
      commandValid(command);
    } catch {
      return Promise.resolve(result("invalid", "Invalid organization command"));
    }
    return enqueue(
      async () => {
        if (disposed()) return result("disposed");
        if (signal?.aborted) return result("unavailable", "Listener is no longer active");
        if (phase !== "ready" || !document)
          return result("unavailable", "A valid current snapshot is required");
        const refused = guard(command);
        if (refused) return refused;
        let next = nextDocument(document, command);
        let body: EventBody | undefined;
        try {
          if (command.type === "reorder-later") {
            const transition = reorderQueue(
              document.later,
              command.sessionIds.map((sessionId) => organizationSessionKey(scope, sessionId)),
            );
            if (!transition.change) return result("noop");
            next = { ...next, later: transition.queue };
            body = {
              type: "queue.reordered",
              before: transition.change.before,
              after: transition.change.after,
              reason: "manual",
            };
          } else {
            const sessionKey = organizationSessionKey(scope, command.sessionId);
            if (command.type === "set-pin") {
              const before = document.pins.includes(sessionKey);
              if (before === command.pinned) return result("noop");
              next = {
                ...next,
                pins: command.pinned
                  ? [...document.pins, sessionKey]
                  : document.pins.filter((key) => key !== sessionKey),
              };
              body = {
                type: "session.pin.changed",
                sessionKey,
                sessionId: command.sessionId,
                before,
                after: command.pinned,
                reason: "manual",
              };
            } else if (command.type === "set-completion") {
              const previous =
                document.completionStates.find((state) => state.sessionKey === sessionKey) ??
                createCompletionState(sessionKey);
              if (
                command.executionSequence !== undefined &&
                command.executionSequence < previous.executionSequence
              )
                return result("stale", "Execution frontier predates the stored state");
              if (
                previous.done === command.done &&
                document.unreconciled.includes(sessionKey) &&
                (command.executionSequence ?? 0) > 0
              )
                return result(
                  "invalid",
                  "Imported completion requires an explicit clear before reconciliation",
                );
              if (previous.done !== command.done && previous.revision === Number.MAX_SAFE_INTEGER)
                return result("invalid", "Completion revision exhausted");
              const transition = setCompletion(previous, {
                done: command.done,
                eventId: command.commandId,
                origin: command.origin,
                expectedRevision: previous.revision,
                executionSequence: command.executionSequence ?? previous.executionSequence,
              });
              if (transition.state === previous) return result("noop");
              next = {
                ...next,
                completionStates: [
                  ...document.completionStates.filter((state) => state.sessionKey !== sessionKey),
                  transition.state,
                ],
                unreconciled: transition.change
                  ? document.unreconciled.filter((key) => key !== sessionKey)
                  : document.unreconciled,
              };
              if (transition.change)
                body = {
                  type: "session.completion.changed",
                  sessionKey,
                  sessionId: command.sessionId,
                  before: transition.change.before,
                  after: transition.change.after,
                  completionRevision: transition.state.revision,
                  reason: "manual",
                };
            } else {
              const transition =
                command.type === "add-later"
                  ? addToQueue(document.later, sessionKey)
                  : removeFromQueue(document.later, sessionKey);
              if (!transition.change) return result("noop");
              next = { ...next, later: transition.queue };
              body = {
                type: command.type === "add-later" ? "queue.added" : "queue.removed",
                sessionKey,
                sessionId: command.sessionId,
                before: transition.change.before,
                after: transition.change.after,
                reason: "manual",
              };
            }
          }
        } catch {
          return result("invalid", "Invalid organization transition");
        }
        return commit(next, command, body, signal);
      },
      () => result(disposed() ? "disposed" : "busy"),
    );
  }
  function migrate(input: OrganizationCommandContext): Promise<OrganizationResult> {
    let context: OrganizationCommandContext;
    try {
      context = structuredClone(input);
      contextValid(context);
    } catch {
      return Promise.resolve(result("invalid", "Invalid migration context"));
    }
    return enqueue(
      async () => {
        if (disposed()) return result("disposed");
        if (phase !== "migration-required" || !legacy)
          return result("unavailable", "No validated migration is pending");
        const refused = guard(context);
        if (refused) return refused;
        try {
          return await commit(nextDocument(migrateOrganizationV0(legacy, scope), context), context);
        } catch {
          return result("invalid", "Migration exceeds the current storage schema limits");
        }
      },
      () => result(disposed() ? "disposed" : "busy"),
    );
  }
  function dispose(): void {
    if (disposed()) return;
    phase = "disposed";
    for (const controller of controllers) controller.abort();
    for (const subscriber of subscribers.values()) {
      subscriber.active = false;
      subscriber.controller?.abort();
    }
    subscribers.clear();
    deliveries.length = 0;
  }
  return Object.freeze({
    start,
    refresh,
    migrate,
    dispatch: (command: OrganizationCommand) => dispatch(command),
    snapshot,
    subscribe,
    dispose,
  });
}
