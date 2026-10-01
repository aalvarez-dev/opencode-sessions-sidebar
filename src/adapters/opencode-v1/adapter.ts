import type { Session } from "@opencode-ai/sdk/v2";
import type {
  ActionResult,
  Activity,
  AdapterChange,
  AdapterState,
  SessionRecord,
  SessionSummary,
  V1Event,
  V1HostPort,
  V1Limits,
  V1Scope,
} from "./types.js";

class Interrupted extends Error {}
type ReplayEntry = V1Event | { type: "action.snapshot"; session: Session };

/** A headless public-API adapter. It neither renders nor persists organization state. */
export function createV1Adapter(host: V1HostPort, inputScope: V1Scope, options: V1Limits = {}) {
  const scope = Object.freeze({ ...inputScope });
  for (const value of [scope.hostId, scope.projectId, scope.directory]) {
    if (!value) throw new TypeError("Host, project, and directory scope are required");
  }
  const limits = {
    maxSessions: options.maxSessions ?? 500,
    maxAttention: options.maxAttention ?? 2000,
    maxEventIds: options.maxEventIds ?? 2048,
    maxBufferedEvents: options.maxBufferedEvents ?? 2048,
    requestTimeoutMs: options.requestTimeoutMs ?? 10_000,
  };
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new RangeError("Adapter limits must be positive safe integers");
  }
  if (limits.requestTimeoutMs > 2_147_483_647)
    throw new RangeError("Request timeout exceeds the timer range");
  const query = {
    directory: scope.directory,
    ...(scope.workspaceId === undefined ? {} : { workspace: scope.workspaceId }),
  };
  const sessions = new Map<string, SessionRecord>();
  const activity = new Map<string, Activity>();
  const failures = new Set<string>();
  const observations = new Map<string, number>();
  const children = new Map<string, Set<string>>();
  const permissions = new Map<string, string>();
  const questions = new Map<string, string>();
  const counts = new Map<string, { permissions: number; questions: number }>();
  const views = new Map<string, SessionRecord>();
  const summaries = new Map<string, SessionSummary>();
  const eventIds = new Set<string>();
  const deleted = new Set<string>();
  const listeners = new Set<(change: AdapterChange) => void>();
  const disposers: (() => void)[] = [];
  const controllers = new Set<AbortController>();
  let phase: AdapterState["phase"] = "idle";
  let refreshing = false;
  let partial = false;
  let attentionCoverage: AdapterState["attentionCoverage"] = "unknown";
  let diagnostic: string | null = null;
  let selectedSessionId: string | null = null;
  let started = false;
  let disposed = false;
  let epoch = 0;
  let actionPending = false;
  let refreshPromise: Promise<void> | undefined;
  let refreshAgain = false;
  let journal: ReplayEntry[] | undefined;
  let journalOverflow = false;
  let batchDepth = 0;
  const dirty = new Set<string>();
  let stateDirty = false;

  function state(): AdapterState {
    return Object.freeze({
      phase,
      refreshing,
      partial,
      attentionCoverage,
      selectedSessionId,
      executionCorrelation: "unavailable",
      diagnostic,
      sessionCount: sessions.size,
      attentionCount: permissions.size + questions.size,
      eventIdCount: eventIds.size,
    });
  }

  function ancestry(id: string): string[] {
    const result = new Set<string>();
    let current: string | null = id;
    while (current && !result.has(current)) {
      result.add(current);
      current = sessions.get(current)?.parentId ?? null;
    }
    return [...result];
  }

  function flush() {
    if (batchDepth || disposed || (!dirty.size && !stateDirty)) return;
    const change = Object.freeze({
      sessionIds: Object.freeze([...dirty]),
      stateChanged: stateDirty,
    });
    dirty.clear();
    stateDirty = false;
    for (const listener of [...listeners]) {
      try {
        Promise.resolve(listener(change)).catch(() => {
          if (!disposed) diagnostic = "An adapter subscriber failed";
        });
      } catch {
        diagnostic = "An adapter subscriber failed";
      }
    }
  }

  function changed(ids: Iterable<string> = [], changedState = false) {
    for (const id of ids) {
      views.delete(id);
      for (const ancestor of ancestry(id)) {
        summaries.delete(ancestor);
        dirty.add(ancestor);
      }
    }
    stateDirty ||= changedState;
    flush();
  }

  function batch(work: () => void) {
    batchDepth++;
    try {
      work();
    } finally {
      batchDepth--;
      flush();
    }
  }

  function incomplete(message: string) {
    partial = true;
    attentionCoverage = "partial";
    diagnostic = message;
    changed([], true);
  }

  function inScope(session: Session) {
    return (
      session.projectID === scope.projectId &&
      session.directory === scope.directory &&
      session.workspaceID === scope.workspaceId
    );
  }

  function putSession(session: Session) {
    if (!inScope(session)) {
      if (sessions.has(session.id)) removeSession(session.id, false);
      return;
    }
    if (deleted.has(session.id)) return;
    const previous = sessions.get(session.id);
    if (!previous && sessions.size >= limits.maxSessions) {
      incomplete("Session capacity reached; session and attention coverage is partial");
      return;
    }
    const next: SessionRecord = Object.freeze({
      id: session.id,
      key: JSON.stringify([scope.hostId, scope.projectId, session.id]),
      title: session.title,
      directory: session.directory,
      projectId: session.projectID,
      workspaceId: session.workspaceID ?? null,
      parentId: session.parentID ?? null,
      ...(session.agent ? { agent: session.agent } : {}),
      updatedAt: session.time.updated,
      activity: "unknown",
      permissions: 0,
      questions: 0,
    });
    if (
      previous &&
      previous.title === next.title &&
      previous.parentId === next.parentId &&
      previous.agent === next.agent &&
      previous.updatedAt === next.updatedAt
    )
      return;
    const affected = ancestry(session.id);
    if (previous?.parentId) {
      const siblings = children.get(previous.parentId);
      siblings?.delete(session.id);
      if (!siblings?.size) children.delete(previous.parentId);
    }
    sessions.set(session.id, next);
    if (next.parentId) {
      const siblings = children.get(next.parentId) ?? new Set<string>();
      siblings.add(next.id);
      children.set(next.parentId, siblings);
    }
    changed([...affected, session.id], true);
  }

  function putActivity(id: string, value: Activity) {
    if (!sessions.has(id)) return;
    // Recovery/new activity supersedes the observed failure without inventing a run ID.
    const clearedFailure = (value === "busy" || value === "retry") && failures.delete(id);
    if (activity.get(id) === value && !clearedFailure) return;
    activity.set(id, value);
    changed([id]);
  }

  function forgetFailures() {
    const affected = [...failures];
    failures.clear();
    changed(affected);
  }

  function attention(kind: "permissions" | "questions", id: string, sessionId?: string) {
    const map = kind === "permissions" ? permissions : questions;
    const previous = map.get(id);
    if (previous === sessionId) return;
    if (
      sessionId !== undefined &&
      !previous &&
      permissions.size + questions.size >= limits.maxAttention
    ) {
      incomplete("Attention capacity reached; pending requests may be missing");
      return;
    }
    if (previous) {
      const count = counts.get(previous)!;
      count[kind]--;
      if (!count.permissions && !count.questions) counts.delete(previous);
      map.delete(id);
    }
    if (sessionId !== undefined) {
      map.set(id, sessionId);
      const count = counts.get(sessionId) ?? { permissions: 0, questions: 0 };
      count[kind]++;
      counts.set(sessionId, count);
    }
    changed([...(previous ? [previous] : []), ...(sessionId ? [sessionId] : [])], true);
  }

  function removeSession(id: string, tombstone = true) {
    const previous = sessions.get(id);
    const affected = ancestry(id);
    if (tombstone) deleted.add(id);
    if (deleted.size > limits.maxEventIds) {
      deleted.delete(deleted.values().next().value!);
      incomplete("Deleted-session history capacity reached; replay coverage is partial");
    }
    if (previous?.parentId) {
      const siblings = children.get(previous.parentId);
      siblings?.delete(id);
      if (!siblings?.size) children.delete(previous.parentId);
    }
    sessions.delete(id);
    activity.delete(id);
    failures.delete(id);
    observations.delete(id);
    for (const [request, owner] of permissions) if (owner === id) attention("permissions", request);
    for (const [request, owner] of questions) if (owner === id) attention("questions", request);
    if (selectedSessionId === id) selectedSessionId = null;
    changed(affected, true);
  }

  function apply(event: V1Event) {
    switch (event.type) {
      case "session.created":
      case "session.updated":
        if (sessions.has(event.properties.info.id))
          observations.set(
            event.properties.info.id,
            (observations.get(event.properties.info.id) ?? 0) + 1,
          );
        putSession(event.properties.info);
        break;
      case "session.deleted":
        if (inScope(event.properties.info)) removeSession(event.properties.info.id);
        break;
      case "session.status":
        putActivity(event.properties.sessionID, event.properties.status.type);
        break;
      case "session.error": {
        const { sessionID, error } = event.properties;
        if (!sessionID || !sessions.has(sessionID) || !error) break;
        if (error.name === "MessageAbortedError") {
          if (failures.delete(sessionID)) changed([sessionID]);
        } else if (!failures.has(sessionID)) {
          failures.add(sessionID);
          changed([sessionID]);
        }
        break;
      }
      case "permission.asked":
      case "question.asked": {
        const request = event.properties;
        if (!sessions.has(request.sessionID)) {
          incomplete(
            "An unscoped session requested attention; refresh is needed to establish coverage",
          );
          break;
        }
        attention(
          event.type === "permission.asked" ? "permissions" : "questions",
          request.id,
          request.sessionID,
        );
        break;
      }
      case "permission.replied":
        attention("permissions", event.properties.requestID);
        break;
      case "question.replied":
      case "question.rejected":
        attention("questions", event.properties.requestID);
        break;
    }
  }

  function record(entry: ReplayEntry) {
    if (!journal) return;
    if (journal.length < limits.maxBufferedEvents) journal.push(entry);
    else {
      journalOverflow = true;
      incomplete("Refresh event buffer overflowed; snapshot was not accepted");
    }
  }

  function observe(event: V1Event) {
    if (disposed || eventIds.has(event.id)) return;
    eventIds.add(event.id);
    if (eventIds.size > limits.maxEventIds) eventIds.delete(eventIds.values().next().value!);
    if (event.type === "server.connected" || event.type === "server.instance.disposed") {
      if (
        event.type === "server.instance.disposed" &&
        event.properties.directory !== scope.directory
      )
        return;
      invalidate();
      void refresh();
      return;
    }
    record(event);
    batch(() => {
      apply(event);
      if (
        (event.type === "session.created" || event.type === "session.updated") &&
        sessions.has(event.properties.info.id) &&
        event.properties.info.parentID &&
        !sessions.has(event.properties.info.parentID)
      )
        incomplete("A session has an unloaded ancestor; ancestor coverage is partial");
    });
  }

  async function bounded<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (disposed) throw new Interrupted("Adapter was disposed");
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), limits.requestTimeoutMs);
    let interrupt!: () => void;
    const interrupted = new Promise<never>((_resolve, reject) => {
      interrupt = () => reject(new Interrupted("Request was interrupted or timed out"));
      controller.signal.addEventListener("abort", interrupt, { once: true });
    });
    try {
      return await Promise.race([work(controller.signal), interrupted]);
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", interrupt);
      controller.abort();
      controllers.delete(controller);
    }
  }

  function invalidate() {
    if (disposed) return;
    const alreadyStale = phase === "stale";
    epoch++;
    for (const controller of controllers) controller.abort();
    phase = "stale";
    refreshing = false;
    attentionCoverage = "unknown";
    batch(() => {
      forgetFailures();
      for (const id of sessions.keys()) putActivity(id, "unknown");
      changed([], !alreadyStale);
    });
  }

  async function readSnapshot() {
    if (disposed) return;
    const capturedEpoch = epoch;
    phase = "loading";
    refreshing = true;
    journal = [];
    journalOverflow = false;
    changed([], true);
    if (disposed || epoch !== capturedEpoch) {
      journal = undefined;
      return;
    }
    try {
      const result = await bounded(async (signal) => {
        const client = host.client;
        const request = { signal, throwOnError: true as const };
        return await Promise.all([
          client.session.list({ ...query, limit: limits.maxSessions }, request),
          client.session.status(query, request),
          client.permission.list(query, request),
          client.question.list(query, request),
        ]);
      });
      if (disposed || epoch !== capturedEpoch) return;
      if (journalOverflow) {
        phase = "stale";
        refreshing = false;
        changed([], true);
        return;
      }
      const [listed, statuses, pendingPermissions, pendingQuestions] = result;
      if (!listed.data || !statuses.data || !pendingPermissions.data || !pendingQuestions.data)
        throw new Error("Incomplete host snapshot");
      const replay = journal ?? [];
      batch(() => {
        partial = listed.data.length >= limits.maxSessions;
        attentionCoverage = "complete";
        diagnostic = partial
          ? "Session listing reached its limit; it is not deletion authority"
          : null;
        const listedIds = new Set(listed.data.filter(inScope).map((session) => session.id));
        // Uncapped exact-directory snapshots reconcile rows without claiming a delete action.
        if (!partial) {
          for (const id of sessions.keys()) if (!listedIds.has(id)) removeSession(id, false);
        }
        for (const session of listed.data) putSession(session);
        for (const id of sessions.keys())
          putActivity(id, statuses.data[id]?.type ?? (listedIds.has(id) ? "idle" : "unknown"));
        for (const id of [...permissions.keys()]) attention("permissions", id);
        for (const id of [...questions.keys()]) attention("questions", id);
        for (const request of pendingPermissions.data) {
          if (!deleted.has(request.sessionID))
            attention("permissions", request.id, request.sessionID);
        }
        for (const request of pendingQuestions.data) {
          if (!deleted.has(request.sessionID))
            attention("questions", request.id, request.sessionID);
        }
        for (const entry of replay) {
          if (entry.type === "action.snapshot") putSession(entry.session);
          else apply(entry);
        }
        if (
          [...counts.keys()].some((id) => !sessions.has(id)) ||
          [...sessions.values()].some(
            (session) => session.parentId && !sessions.has(session.parentId),
          )
        )
          incomplete("Pending attention includes unloaded sessions; ancestor coverage is partial");
        phase = "ready";
        refreshing = false;
        changed([], true);
      });
    } catch (error) {
      if (disposed || capturedEpoch !== epoch) return;
      phase = "error";
      refreshing = false;
      attentionCoverage = "unknown";
      diagnostic = error instanceof Interrupted ? error.message : "Host snapshot failed";
      batch(() => {
        forgetFailures();
        for (const id of sessions.keys()) putActivity(id, "unknown");
        changed([], true);
      });
    } finally {
      journal = undefined;
      if (refreshing) {
        refreshing = false;
        changed([], true);
      }
    }
  }

  function refresh(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (refreshPromise) {
      if (phase === "stale") refreshAgain = true;
      return refreshPromise;
    }
    refreshPromise = Promise.resolve()
      .then(async () => {
        do {
          refreshAgain = false;
          await readSnapshot();
        } while (refreshAgain && !disposed);
      })
      .finally(() => {
        refreshPromise = undefined;
      });
    return refreshPromise;
  }

  function observeRoute() {
    if (disposed) return;
    const route = host.route.current;
    const candidate = route.name === "session" ? route.params?.sessionID : undefined;
    const next = typeof candidate === "string" && sessions.has(candidate) ? candidate : null;
    if (next === selectedSessionId) return;
    selectedSessionId = next;
    changed([], true);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    epoch++;
    phase = "disposed";
    refreshing = false;
    for (const controller of controllers) controller.abort();
    for (const unsubscribe of disposers.splice(0)) {
      try {
        unsubscribe();
      } catch {
        diagnostic = "A host disposer failed";
      }
    }
    listeners.clear();
    journal = undefined;
    for (const map of [
      sessions,
      activity,
      observations,
      children,
      permissions,
      questions,
      counts,
      views,
      summaries,
    ])
      map.clear();
    eventIds.clear();
    failures.clear();
    deleted.clear();
    dirty.clear();
  }

  function start(): Promise<void> {
    if (disposed || host.lifecycle.signal.aborted) {
      dispose();
      return Promise.resolve();
    }
    if (!started) {
      started = true;
      const types: V1Event["type"][] = [
        "session.created",
        "session.updated",
        "session.deleted",
        "session.status",
        "session.error",
        "permission.asked",
        "permission.replied",
        "question.asked",
        "question.replied",
        "question.rejected",
        "server.connected",
        "server.instance.disposed",
      ];
      for (const type of types) disposers.push(host.event.on(type, observe));
      disposers.push(host.lifecycle.onDispose(dispose));
      host.lifecycle.signal.addEventListener("abort", dispose, { once: true });
      disposers.push(() => host.lifecycle.signal.removeEventListener("abort", dispose));
    }
    return refresh().then(observeRoute);
  }

  function get(id: string): SessionRecord | undefined {
    const existing = sessions.get(id);
    if (!existing) return;
    let cached = views.get(id);
    if (!cached) {
      cached = Object.freeze({
        ...existing,
        activity: activity.get(id) ?? "unknown",
        // Some host errors initiate recovery (for example auto-compaction). Only
        // expose a settled error alongside confirmed idle, never over live work.
        error: failures.has(id) && activity.get(id) === "idle",
        permissions: counts.get(id)?.permissions ?? 0,
        questions: counts.get(id)?.questions ?? 0,
      });
      views.set(id, cached);
    }
    return cached;
  }

  function summary(id: string): SessionSummary | undefined {
    if (!sessions.has(id)) return;
    const cached = summaries.get(id);
    if (cached) return cached;
    const result = { busy: 0, retry: 0, unknown: 0, permissions: 0, questions: 0, errors: 0 };
    const visited = new Set<string>();
    const pending = [id];
    while (pending.length) {
      const current = pending.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      const record = get(current);
      if (!record) continue;
      if (record.activity !== "idle") result[record.activity]++;
      result.permissions += record.permissions;
      result.questions += record.questions;
      if (record.error) result.errors++;
      pending.push(...(children.get(current) ?? []));
    }
    const value = Object.freeze(result);
    summaries.set(id, value);
    return value;
  }

  async function action(
    kind: "create" | "rename" | "delete",
    id?: string,
    title?: string,
  ): Promise<ActionResult> {
    if (disposed || !started)
      return Object.freeze({ status: "failed", message: "Adapter is not active" });
    if (actionPending)
      return Object.freeze({ status: "failed", message: "Another action is in progress" });
    if (kind !== "create" && (!id || !sessions.has(id)))
      return Object.freeze({ status: "failed", message: "Session is outside the loaded scope" });
    actionPending = true;
    const capturedEpoch = epoch;
    const original = id ? sessions.get(id) : undefined;
    const observedVersion = id ? (observations.get(id) ?? 0) : 0;
    try {
      const response = await bounded(async (signal) => {
        const client = host.client;
        const request = { signal, throwOnError: true as const };
        if (kind === "create")
          return client.session.create({ ...query, title: title ?? "" }, request);
        if (kind === "rename")
          return client.session.update({ ...query, sessionID: id!, title: title ?? "" }, request);
        return client.session.delete({ ...query, sessionID: id! }, request);
      });
      if (disposed || epoch !== capturedEpoch || (id && deleted.has(id) && kind !== "delete"))
        return Object.freeze({
          status: "unknown",
          message: "The operation outlived its observed scope",
        });
      if (kind === "delete") {
        if (response.data !== true)
          return Object.freeze({ status: "failed", message: "Host did not confirm deletion" });
        batch(() => removeSession(id!));
        return Object.freeze({ status: "succeeded", sessionId: id! });
      }
      if (!response.data || typeof response.data !== "object" || !inScope(response.data))
        return Object.freeze({
          status: "unknown",
          message: "Host result did not establish the requested scope",
        });
      const current = id ? sessions.get(id) : undefined;
      // A later host event wins over this response, even when timestamps are equal.
      if (
        id
          ? current === original && (observations.get(id) ?? 0) === observedVersion
          : !sessions.has(response.data.id)
      ) {
        const session = response.data;
        record({ type: "action.snapshot", session });
        batch(() => putSession(session));
      }
      return Object.freeze({ status: "succeeded", sessionId: response.data.id });
    } catch (error) {
      return Object.freeze({
        status: "unknown",
        message: error instanceof Interrupted ? error.message : "Host action failed",
      });
    } finally {
      actionPending = false;
    }
  }

  return {
    start,
    refresh,
    invalidate,
    dispose,
    get,
    summary,
    state,
    observeRoute,
    list: (): readonly SessionRecord[] => Object.freeze([...sessions.keys()].map((id) => get(id)!)),
    subscribe(listener: (change: AdapterChange) => void) {
      if (disposed) return () => {};
      if (listeners.size >= 64) throw new RangeError("Adapter subscriber capacity reached");
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    create: (title: string) => action("create", undefined, title),
    rename: (id: string, title: string) => action("rename", id, title),
    delete: (id: string) => action("delete", id),
    open(id: string): ActionResult {
      if (disposed || !sessions.has(id))
        return Object.freeze({ status: "failed", message: "Session is outside the loaded scope" });
      try {
        host.route.navigate("session", { sessionID: id });
        return Object.freeze({ status: "requested", sessionId: id });
      } catch {
        return Object.freeze({ status: "failed", message: "Host navigation failed" });
      }
    },
  };
}
