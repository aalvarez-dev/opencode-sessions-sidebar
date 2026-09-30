import { afterEach, describe, expect, test } from "bun:test";
import type {
  Event,
  PermissionRequest,
  QuestionRequest,
  Session,
  SessionStatus,
} from "@opencode-ai/sdk/v2";
import { createV1Adapter } from "../src/adapters/opencode-v1";
import type { V1HostPort, V1Limits } from "../src/adapters/opencode-v1/types";

const scope = {
  hostId: "test-host",
  projectId: "test-project",
  directory: "/synthetic/project",
};

function session(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    slug: id,
    projectID: scope.projectId,
    directory: scope.directory,
    title: `Session ${id}`,
    version: "test",
    time: { created: 1, updated: 1 },
    ...overrides,
  };
}

function permission(id: string, sessionID: string): PermissionRequest {
  return { id, sessionID, permission: "test", patterns: [], always: [], metadata: {} };
}

function question(id: string, sessionID: string): QuestionRequest {
  return { id, sessionID, questions: [] };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

type RequestOptions = { signal?: AbortSignal };

/** SDK-shaped fake, with deferred reads that deliberately need not honor abort. */
class FakeHost {
  sessions: Session[] = [];
  statuses: Record<string, SessionStatus> = {};
  permissions: PermissionRequest[] = [];
  questions: QuestionRequest[] = [];
  calls = { list: 0, status: 0, permissions: 0, questions: 0, create: 0, update: 0, delete: 0 };
  requests: { kind: string; parameters: unknown; signal: AbortSignal | undefined }[] = [];
  handlers = new Map<Event["type"], Set<(event: Event) => void>>();
  lifecycleCallbacks = new Set<() => void | Promise<void>>();
  lifecycleController = new AbortController();
  currentRoute: V1HostPort["route"]["current"] = { name: "home" };
  navigations: { name: string; params: Record<string, unknown> | undefined }[] = [];
  listRead: () => Promise<Session[]> = async () => this.sessions;
  statusRead: () => Promise<Record<string, SessionStatus>> = async () => this.statuses;
  permissionRead: () => Promise<PermissionRequest[]> = async () => this.permissions;
  questionRead: () => Promise<QuestionRequest[]> = async () => this.questions;
  createWrite: (title: string) => Promise<Session> = async (title) => session("created", { title });
  updateWrite: (id: string, title: string) => Promise<Session> = async (id, title) =>
    session(id, { title, time: { created: 1, updated: 2 } });
  deleteWrite: (id: string) => Promise<boolean> = async () => true;
  activeClient = this.makeClient();

  makeClient(): V1HostPort["client"] {
    const record = (kind: string, parameters: unknown, options?: RequestOptions) => {
      this.requests.push({ kind, parameters, signal: options?.signal });
    };
    // The generated SDK has polymorphic request result types. This single fixture
    // boundary supplies its normal fields envelope; production compatibility is typed separately.
    return {
      session: {
        list: async (parameters: unknown, options?: RequestOptions) => {
          this.calls.list++;
          record("list", parameters, options);
          return { data: await this.listRead() };
        },
        status: async (parameters: unknown, options?: RequestOptions) => {
          this.calls.status++;
          record("status", parameters, options);
          return { data: await this.statusRead() };
        },
        create: async (parameters: { title?: string }, options?: RequestOptions) => {
          this.calls.create++;
          record("create", parameters, options);
          return { data: await this.createWrite(parameters.title ?? "") };
        },
        update: async (
          parameters: { sessionID: string; title: string },
          options?: RequestOptions,
        ) => {
          this.calls.update++;
          record("update", parameters, options);
          return { data: await this.updateWrite(parameters.sessionID, parameters.title) };
        },
        delete: async (parameters: { sessionID: string }, options?: RequestOptions) => {
          this.calls.delete++;
          record("delete", parameters, options);
          return { data: await this.deleteWrite(parameters.sessionID) };
        },
      },
      permission: {
        list: async (parameters: unknown, options?: RequestOptions) => {
          this.calls.permissions++;
          record("permissions", parameters, options);
          return { data: await this.permissionRead() };
        },
      },
      question: {
        list: async (parameters: unknown, options?: RequestOptions) => {
          this.calls.questions++;
          record("questions", parameters, options);
          return { data: await this.questionRead() };
        },
      },
    } as unknown as V1HostPort["client"];
  }

  get port(): V1HostPort {
    const fake = this;
    return {
      get client() {
        return fake.activeClient;
      },
      event: {
        on(type, handler) {
          const callback = (event: Event) => {
            if (event.type === type) handler(event as Parameters<typeof handler>[0]);
          };
          const set = fake.handlers.get(type) ?? new Set();
          set.add(callback);
          fake.handlers.set(type, set);
          return () => set.delete(callback);
        },
      },
      lifecycle: {
        signal: fake.lifecycleController.signal,
        onDispose(callback) {
          fake.lifecycleCallbacks.add(callback);
          return () => fake.lifecycleCallbacks.delete(callback);
        },
      },
      route: {
        get current() {
          return fake.currentRoute;
        },
        navigate(name, params) {
          fake.navigations.push({ name, params });
        },
      },
    };
  }

  emit(event: Event) {
    for (const handler of this.handlers.get(event.type) ?? []) handler(event);
  }

  status(id: string, sessionID: string, status: SessionStatus) {
    this.emit({ id, type: "session.status", properties: { sessionID, status } });
  }

  get subscriptionCount() {
    return [...this.handlers.values()].reduce((total, set) => total + set.size, 0);
  }
}

const adapters: ReturnType<typeof createV1Adapter>[] = [];

function adapterFor(host: FakeHost, limits?: V1Limits) {
  const adapter = createV1Adapter(host.port, scope, limits);
  adapters.push(adapter);
  return adapter;
}

afterEach(() => {
  for (const adapter of adapters.splice(0)) adapter.dispose();
});

describe("V1 adapter contract with a fake public host", () => {
  test("starts once, scopes snapshots, and infers idle only for covered sessions", async () => {
    const host = new FakeHost();
    host.sessions = [
      session("idle"),
      session("busy"),
      session("other-project", { projectID: "elsewhere" }),
      session("other-directory", { directory: "/synthetic/elsewhere" }),
      session("other-workspace", { workspaceID: "elsewhere" }),
    ];
    host.statuses = { busy: { type: "busy" }, unknown: { type: "busy" } };
    host.permissions = [permission("p1", "busy")];
    host.questions = [question("q1", "busy")];
    const adapter = adapterFor(host);
    expect(host.calls.list).toBe(0);
    expect(adapter.state().phase).toBe("idle");

    await Promise.all([adapter.start(), adapter.start()]);

    expect(host.calls).toMatchObject({ list: 1, status: 1, permissions: 1, questions: 1 });
    expect(
      adapter
        .list()
        .map((record) => record.id)
        .sort(),
    ).toEqual(["busy", "idle"]);
    expect(adapter.get("idle")?.activity).toBe("idle");
    expect(adapter.get("busy")).toMatchObject({ activity: "busy", permissions: 1, questions: 1 });
    expect(adapter.get("unknown")).toBeUndefined();
    expect(adapter.state()).toMatchObject({ phase: "ready", executionCorrelation: "unavailable" });
    expect(host.requests.find((request) => request.kind === "list")?.parameters).toMatchObject({
      directory: scope.directory,
      limit: expect.any(Number),
    });
  });

  test("subscribes before bootstrap and preserves newer status and title over stale snapshots", async () => {
    const host = new FakeHost();
    const list = deferred<Session[]>();
    const statuses = deferred<Record<string, SessionStatus>>();
    host.listRead = () => list.promise;
    host.statusRead = () => statuses.promise;
    const adapter = adapterFor(host);
    const starting = adapter.start();
    expect(host.subscriptionCount).toBeGreaterThan(0);
    await Promise.resolve();
    host.emit({
      id: "created-live",
      type: "session.created",
      properties: { sessionID: "a", info: session("a") },
    });
    host.status("busy-live", "a", { type: "busy" });
    host.emit({
      id: "title-live",
      type: "session.updated",
      properties: { sessionID: "a", info: session("a", { title: "New title" }) },
    });
    list.resolve([session("a", { title: "Old title" })]);
    statuses.resolve({ a: { type: "idle" } });
    await starting;
    expect(adapter.get("a")).toMatchObject({ title: "New title", activity: "busy" });
  });

  test("a reply during bootstrap cannot resurrect attention from the pending snapshot", async () => {
    const host = new FakeHost();
    host.sessions = [session("a")];
    const permissions = deferred<PermissionRequest[]>();
    const questions = deferred<QuestionRequest[]>();
    host.permissionRead = () => permissions.promise;
    host.questionRead = () => questions.promise;
    const adapter = adapterFor(host);
    const starting = adapter.start();
    await Promise.resolve();
    host.emit({
      id: "permission-replied",
      type: "permission.replied",
      properties: { sessionID: "a", requestID: "p1", reply: "once" },
    });
    host.emit({
      id: "question-rejected",
      type: "question.rejected",
      properties: { sessionID: "a", requestID: "q1" },
    });
    permissions.resolve([permission("p1", "a")]);
    questions.resolve([question("q1", "a")]);
    await starting;
    expect(adapter.get("a")).toMatchObject({ permissions: 0, questions: 0 });
    expect(adapter.state().attentionCount).toBe(0);
  });

  test("deletion during a refresh wins over both stale list and attention responses", async () => {
    const host = new FakeHost();
    host.sessions = [session("a")];
    const adapter = adapterFor(host);
    await adapter.start();
    const list = deferred<Session[]>();
    host.listRead = () => list.promise;
    host.permissions = [permission("old-request", "a")];
    const refresh = adapter.refresh();
    await Promise.resolve();
    host.emit({
      id: "deleted-live",
      type: "session.deleted",
      properties: { sessionID: "a", info: session("a") },
    });
    list.resolve([session("a")]);
    await refresh;
    expect(adapter.get("a")).toBeUndefined();
    expect(adapter.state().attentionCount).toBe(0);
  });

  test("coalesces refreshes and does not mistake capped list omission for deletion", async () => {
    const host = new FakeHost();
    host.sessions = [session("a"), session("b")];
    const adapter = adapterFor(host, { maxSessions: 2 });
    await adapter.start();
    const list = deferred<Session[]>();
    host.listRead = () => list.promise;
    const first = adapter.refresh();
    const second = adapter.refresh();
    list.resolve([session("a"), session("c")]);
    await Promise.all([first, second]);
    expect(host.calls.list).toBe(2);
    expect(adapter.get("b")).toBeDefined();
    expect(adapter.state()).toMatchObject({ partial: true, sessionCount: 2 });
  });

  test("duplicate busy events never create execution correlation or refresh the full list", async () => {
    const host = new FakeHost();
    host.sessions = [session("a"), session("unaffected")];
    const adapter = adapterFor(host);
    await adapter.start();
    const before = adapter.get("a");
    const unaffected = adapter.get("unaffected");
    host.status("busy-1", "a", { type: "busy" });
    const busy = adapter.get("a");
    host.status("busy-1", "a", { type: "busy" });
    host.status("busy-2", "a", { type: "busy" });
    expect(adapter.get("a")).toBe(busy);
    expect(adapter.get("unaffected")).toBe(unaffected);
    expect(before?.activity).toBe("idle");
    expect(Object.isFrozen(busy)).toBe(true);
    expect(adapter.state().executionCorrelation).toBe("unavailable");
    expect(host.calls.list).toBe(1);
  });

  test("aggregates descendant activity and attention without leaking to sibling roots", async () => {
    const host = new FakeHost();
    host.sessions = [
      session("root"),
      session("child", { parentID: "root" }),
      session("grandchild", { parentID: "child" }),
      session("other"),
      session("orphan", { parentID: "absent" }),
    ];
    host.statuses = { child: { type: "busy" }, orphan: { type: "busy" } };
    host.permissions = [permission("p", "grandchild"), permission("orphan-p", "orphan")];
    host.questions = [question("q", "child")];
    const adapter = adapterFor(host);
    await adapter.start();
    expect(adapter.summary("root")).toEqual({
      busy: 1,
      retry: 0,
      unknown: 0,
      permissions: 1,
      questions: 1,
    });
    expect(adapter.summary("other")).toEqual({
      busy: 0,
      retry: 0,
      unknown: 0,
      permissions: 0,
      questions: 0,
    });
    expect(adapter.summary("absent")).toBeUndefined();
    expect(adapter.summary("orphan")?.permissions).toBe(1);
  });

  test("a cyclic parent chain cannot loop or count a session twice", async () => {
    const host = new FakeHost();
    host.sessions = [session("a", { parentID: "b" }), session("b", { parentID: "a" })];
    host.statuses = { a: { type: "busy" }, b: { type: "busy" } };
    host.permissions = [permission("p", "b")];
    const adapter = adapterFor(host);
    await adapter.start();
    expect(adapter.summary("a")).toEqual({
      busy: 2,
      retry: 0,
      unknown: 0,
      permissions: 1,
      questions: 0,
    });
    expect(adapter.summary("b")).toEqual(adapter.summary("a"));
  });

  test("a child listed before its parent does not make a complete snapshot partial", async () => {
    const host = new FakeHost();
    host.sessions = [session("child", { parentID: "parent" }), session("parent")];
    host.permissions = [permission("p", "child")];
    const adapter = adapterFor(host);
    await adapter.start();
    expect(adapter.state()).toMatchObject({
      phase: "ready",
      partial: false,
      attentionCoverage: "complete",
    });
    expect(adapter.summary("parent")?.permissions).toBe(1);
  });

  test("unknown events do not create rows and a session moving out of scope is evicted", async () => {
    const host = new FakeHost();
    host.sessions = [session("a")];
    const adapter = adapterFor(host);
    await adapter.start();
    host.status("unknown-status", "unknown", { type: "busy" });
    host.emit({
      id: "unknown-permission",
      type: "permission.asked",
      properties: permission("p", "unknown"),
    });
    host.emit({
      id: "foreign-title",
      type: "session.updated",
      properties: {
        sessionID: "a",
        info: session("a", { projectID: "foreign", title: "Foreign" }),
      },
    });
    expect(adapter.get("a")).toBeUndefined();
    expect((await adapter.rename("a", "Must not be sent")).status).toBe("failed");
    expect(host.calls.update).toBe(0);
    expect(adapter.get("unknown")).toBeUndefined();
    expect(adapter.state().sessionCount).toBe(0);
  });

  test("invalidation makes activity unknown and prevents an obsolete read from committing", async () => {
    const host = new FakeHost();
    host.sessions = [session("a")];
    host.statuses = { a: { type: "busy" } };
    const adapter = adapterFor(host);
    await adapter.start();
    const list = deferred<Session[]>();
    host.listRead = () => list.promise;
    const refreshing = adapter.refresh();
    await Promise.resolve();
    adapter.invalidate();
    await refreshing;
    expect(adapter.state().phase).toBe("stale");
    expect(adapter.get("a")?.activity).toBe("unknown");
    list.resolve([session("a", { title: "Obsolete" })]);
    await Promise.resolve();
    expect(adapter.get("a")?.title).toBe("Session a");
  });

  test("repeated invalidation aborts an action started while the adapter was already stale", async () => {
    const host = new FakeHost();
    host.sessions = [session("a")];
    const adapter = adapterFor(host);
    await adapter.start();
    adapter.invalidate();
    const update = deferred<Session>();
    host.updateWrite = () => update.promise;
    const renaming = adapter.rename("a", "Stale action response");
    adapter.invalidate();
    expect((await renaming).status).toBe("unknown");
    expect(host.requests.find((request) => request.kind === "update")?.signal?.aborted).toBe(true);
    expect(adapter.state().phase).toBe("stale");
    update.resolve(session("a", { title: "Stale action response" }));
    await Promise.resolve();
    expect(adapter.get("a")?.title).toBe("Session a");
  });

  test("disposal unsubscribes and settles a read whose host ignores cancellation", async () => {
    const host = new FakeHost();
    const list = deferred<Session[]>();
    host.listRead = () => list.promise;
    const adapter = adapterFor(host);
    const starting = adapter.start();
    await Promise.resolve();
    adapter.dispose();
    await starting;
    expect(host.subscriptionCount).toBe(0);
    expect(host.lifecycleCallbacks.size).toBe(0);
    expect(adapter.state().phase).toBe("disposed");
    expect(host.requests.every((request) => request.signal?.aborted)).toBe(true);
    list.resolve([session("late")]);
    host.status("late-status", "late", { type: "busy" });
    await Promise.resolve();
    expect(adapter.get("late")).toBeUndefined();
  });

  test("immediate disposal cancels scheduled bootstrap before it makes any host request", async () => {
    const host = new FakeHost();
    const adapter = adapterFor(host);
    const starting = adapter.start();
    adapter.dispose();
    await starting;
    expect(adapter.state().phase).toBe("disposed");
    expect(host.requests).toHaveLength(0);
    expect(host.subscriptionCount).toBe(0);
  });

  test("disposal from a loading subscriber prevents the announced read from starting", async () => {
    const host = new FakeHost();
    const adapter = adapterFor(host);
    adapter.subscribe(() => {
      if (adapter.state().phase === "loading") adapter.dispose();
    });
    await adapter.start();
    expect(adapter.state().phase).toBe("disposed");
    expect(host.requests).toHaveLength(0);
    expect(host.subscriptionCount).toBe(0);
  });

  test("bounded event IDs and attention make incomplete coverage explicit", async () => {
    const host = new FakeHost();
    host.sessions = [session("a")];
    const adapter = adapterFor(host, { maxEventIds: 3, maxAttention: 2 });
    await adapter.start();
    for (let index = 0; index < 10; index++) {
      host.emit({
        id: `asked-${index}`,
        type: "permission.asked",
        properties: permission(`p-${index}`, "a"),
      });
    }
    expect(adapter.state().eventIdCount).toBeLessThanOrEqual(3);
    expect(adapter.state().attentionCount).toBeLessThanOrEqual(2);
    expect(adapter.state().attentionCoverage).toBe("partial");
    expect(adapter.get("a")?.permissions).toBeGreaterThan(0);
    expect(host.calls.list).toBe(1);
  });

  test("delete requires true acknowledgement and transport failures have unknown outcome", async () => {
    const host = new FakeHost();
    host.sessions = [session("a")];
    const adapter = adapterFor(host);
    await adapter.start();
    host.deleteWrite = async () => false;
    expect((await adapter.delete("a")).status).toBe("failed");
    expect(adapter.get("a")).toBeDefined();
    host.updateWrite = async () => {
      throw new Error("Synthetic host rejection");
    };
    expect((await adapter.rename("a", "Rejected")).status).toBe("unknown");
    expect(adapter.get("a")?.title).toBe("Session a");
    host.deleteWrite = async () => true;
    expect((await adapter.delete("a")).status).toBe("succeeded");
    expect(adapter.get("a")).toBeUndefined();
  });

  test("host deletion during rename prevents a late action result from recreating the session", async () => {
    const host = new FakeHost();
    host.sessions = [session("a")];
    const adapter = adapterFor(host);
    await adapter.start();
    const update = deferred<Session>();
    host.updateWrite = () => update.promise;
    const renaming = adapter.rename("a", "Late title");
    expect((await adapter.create("Concurrent")).status).toBe("failed");
    expect(host.calls.create).toBe(0);
    host.emit({
      id: "deleted",
      type: "session.deleted",
      properties: { sessionID: "a", info: session("a") },
    });
    update.resolve(session("a", { title: "Late title" }));
    expect((await renaming).status).toBe("unknown");
    expect(adapter.get("a")).toBeUndefined();
  });

  test("a later unchanged host observation still takes precedence over a pending rename response", async () => {
    const host = new FakeHost();
    host.sessions = [session("a")];
    const adapter = adapterFor(host);
    await adapter.start();
    const update = deferred<Session>();
    host.updateWrite = () => update.promise;
    const renaming = adapter.rename("a", "Superseded response");
    host.emit({
      id: "later-host-observation",
      type: "session.updated",
      properties: { sessionID: "a", info: session("a") },
    });
    update.resolve(session("a", { title: "Superseded response" }));
    expect((await renaming).status).toBe("succeeded");
    expect(adapter.get("a")?.title).toBe("Session a");
  });

  test("an action cancelled by disposal has unknown outcome and cannot mutate local state", async () => {
    const host = new FakeHost();
    const adapter = adapterFor(host);
    await adapter.start();
    const create = deferred<Session>();
    host.createWrite = () => create.promise;
    const creating = adapter.create("New");
    adapter.dispose();
    expect((await creating).status).toBe("unknown");
    create.resolve(session("created"));
    await Promise.resolve();
    expect(adapter.get("created")).toBeUndefined();
  });

  test("navigation stays a request until the current route confirms selection", async () => {
    const host = new FakeHost();
    host.sessions = [session("a")];
    const adapter = adapterFor(host);
    await adapter.start();
    expect(adapter.open("a").status).toBe("requested");
    expect(host.navigations).toEqual([{ name: "session", params: { sessionID: "a" } }]);
    expect(adapter.state().selectedSessionId).toBeNull();
    host.currentRoute = { name: "session", params: { sessionID: "a" } };
    adapter.observeRoute();
    expect(adapter.state().selectedSessionId).toBe("a");
    expect(host.calls).toMatchObject({ create: 0, update: 0, delete: 0 });
  });

  test("reconnect reads the current host client and reconciles after cancelling an old read", async () => {
    const host = new FakeHost();
    host.sessions = [session("a")];
    const adapter = adapterFor(host);
    await adapter.start();
    const oldRead = deferred<Session[]>();
    host.listRead = () => oldRead.promise;
    const refreshing = adapter.refresh();
    await Promise.resolve();
    const replacement = new FakeHost();
    replacement.sessions = [session("a", { title: "Current client" })];
    replacement.statuses = { a: { type: "busy" } };
    host.activeClient = replacement.makeClient();
    host.emit({ id: "reconnected", type: "server.connected", properties: {} });
    await refreshing;
    expect(replacement.calls.list).toBe(1);
    expect(adapter.get("a")).toMatchObject({ title: "Current client", activity: "busy" });
    expect(adapter.state().phase).toBe("ready");
    oldRead.resolve([session("a", { title: "Obsolete client" })]);
    await Promise.resolve();
    expect(adapter.get("a")?.title).toBe("Current client");
  });

  test("an overflowing bootstrap event buffer refuses to certify an obsolete snapshot", async () => {
    const host = new FakeHost();
    const list = deferred<Session[]>();
    host.listRead = () => list.promise;
    const adapter = adapterFor(host, { maxBufferedEvents: 1 });
    const starting = adapter.start();
    await Promise.resolve();
    host.emit({
      id: "created",
      type: "session.created",
      properties: { sessionID: "live", info: session("live") },
    });
    host.status("busy", "live", { type: "busy" });
    list.resolve([session("stale-snapshot")]);
    await starting;
    expect(adapter.state()).toMatchObject({
      phase: "stale",
      partial: true,
      attentionCoverage: "partial",
    });
    expect(adapter.get("live")?.activity).toBe("busy");
    expect(adapter.get("stale-snapshot")).toBeUndefined();
  });

  test("failed refresh makes activity unknown while retaining known pending attention", async () => {
    const host = new FakeHost();
    host.sessions = [session("a")];
    host.permissions = [permission("p", "a")];
    const adapter = adapterFor(host);
    await adapter.start();
    host.statusRead = async () => {
      throw new Error("Synthetic unavailable host");
    };
    await adapter.refresh();
    expect(adapter.state()).toMatchObject({ phase: "error", attentionCoverage: "unknown" });
    expect(adapter.get("a")).toMatchObject({ activity: "unknown", permissions: 1 });
    expect(adapter.state().diagnostic).toBeTruthy();
  });

  test("a failed snapshot read cancels its pending sibling requests", async () => {
    const host = new FakeHost();
    const list = deferred<Session[]>();
    const statuses = deferred<Record<string, SessionStatus>>();
    const questions = deferred<QuestionRequest[]>();
    host.listRead = () => list.promise;
    host.statusRead = () => statuses.promise;
    host.questionRead = () => questions.promise;
    host.permissionRead = async () => {
      throw new Error("Synthetic snapshot failure");
    };
    const adapter = adapterFor(host);
    await adapter.start();
    expect(adapter.state().phase).toBe("error");
    expect(host.requests).toHaveLength(4);
    expect(host.requests.every((request) => request.signal?.aborted === true)).toBe(true);
    list.resolve([session("obsolete")]);
    statuses.resolve({});
    questions.resolve([]);
    await Promise.resolve();
    expect(adapter.get("obsolete")).toBeUndefined();
  });

  test("subscriber failures neither block other listeners nor roll back host state", async () => {
    const host = new FakeHost();
    host.sessions = [session("a"), session("unrelated")];
    const adapter = adapterFor(host);
    await adapter.start();
    adapter.subscribe(() => {
      throw new Error("Synthetic observer failure");
    });
    const calls: (readonly string[])[] = [];
    const unsubscribe = adapter.subscribe((change) => calls.push(change.sessionIds));
    host.status("busy", "a", { type: "busy" });
    expect(calls).toEqual([["a"]]);
    expect(adapter.get("a")?.activity).toBe("busy");
    expect(adapter.state().diagnostic).toBeTruthy();
    unsubscribe();
    host.status("idle", "a", { type: "idle" });
    expect(calls).toHaveLength(1);
  });

  test("unknown snapshot attention remains visible as incomplete ancestor coverage", async () => {
    const host = new FakeHost();
    host.sessions = [session("a")];
    host.permissions = [permission("unloaded-permission", "unloaded")];
    const adapter = adapterFor(host);
    await adapter.start();
    expect(adapter.state()).toMatchObject({
      attentionCount: 1,
      attentionCoverage: "partial",
      partial: true,
    });
    expect(adapter.get("a")?.permissions).toBe(0);
    expect(adapter.summary("a")?.permissions).toBe(0);
  });

  test("a confirmed rename during a pending refresh cannot be overwritten by its old list", async () => {
    const host = new FakeHost();
    host.sessions = [session("a")];
    const adapter = adapterFor(host);
    await adapter.start();
    const list = deferred<Session[]>();
    host.listRead = () => list.promise;
    const refreshing = adapter.refresh();
    await Promise.resolve();
    expect((await adapter.rename("a", "Confirmed title")).status).toBe("succeeded");
    list.resolve([session("a")]);
    await refreshing;
    expect(adapter.get("a")?.title).toBe("Confirmed title");
  });

  test("a confirmed creation during a pending refresh survives its older complete list", async () => {
    const host = new FakeHost();
    host.sessions = [session("a")];
    const adapter = adapterFor(host);
    await adapter.start();
    const list = deferred<Session[]>();
    host.listRead = () => list.promise;
    const refreshing = adapter.refresh();
    await Promise.resolve();
    expect((await adapter.create("Confirmed creation")).status).toBe("succeeded");
    list.resolve([session("a")]);
    await refreshing;
    expect(adapter.get("created")?.title).toBe("Confirmed creation");
  });

  test("a complete scoped refresh removes rows missed during disconnection", async () => {
    const host = new FakeHost();
    host.sessions = [session("a"), session("deleted-offline")];
    const adapter = adapterFor(host, { maxSessions: 3 });
    await adapter.start();
    adapter.invalidate();
    host.sessions = [session("a")];
    await adapter.refresh();
    expect(adapter.get("deleted-offline")).toBeUndefined();
    expect((await adapter.delete("deleted-offline")).status).toBe("failed");
    expect(host.calls.delete).toBe(0);
    expect(adapter.state().partial).toBe(false);
  });

  test("an omitted row in a capped refresh remains unknown instead of falsely idle", async () => {
    const host = new FakeHost();
    host.sessions = [session("a"), session("b")];
    host.statuses = { b: { type: "busy" } };
    const adapter = adapterFor(host, { maxSessions: 2 });
    await adapter.start();
    host.sessions = [session("a"), session("newer")];
    host.statuses = {};
    await adapter.refresh();
    expect(adapter.get("b")?.activity).toBe("unknown");
    expect(adapter.state().partial).toBe(true);
  });

  test("a subscriber refreshing during the loading notification cannot start overlapping reads", async () => {
    const host = new FakeHost();
    host.sessions = [session("a")];
    const adapter = adapterFor(host);
    let nested: Promise<void> | undefined;
    adapter.subscribe(() => {
      if (adapter.state().phase === "loading" && !nested) nested = adapter.refresh();
    });
    await adapter.start();
    await nested;
    expect(host.calls).toMatchObject({ list: 1, status: 1, permissions: 1, questions: 1 });
    expect(adapter.state().phase).toBe("ready");
  });

  test("a rejecting asynchronous subscriber does not escape or prevent another observer", async () => {
    const host = new FakeHost();
    host.sessions = [session("a")];
    const adapter = adapterFor(host);
    await adapter.start();
    let delivered = 0;
    adapter.subscribe(async () => {
      throw new Error("Synthetic async observer failure");
    });
    adapter.subscribe(() => {
      delivered++;
    });
    host.status("busy", "a", { type: "busy" });
    await Promise.resolve();
    await Promise.resolve();
    expect(delivered).toBe(1);
    expect(adapter.get("a")?.activity).toBe("busy");
    expect(adapter.state().diagnostic).toBeTruthy();
  });

  test("rejects nonpositive and fractional resource limits", () => {
    const host = new FakeHost();
    for (const limits of [
      { maxSessions: 0 },
      { maxAttention: -1 },
      { maxEventIds: 1.5 },
      { maxBufferedEvents: 0 },
    ]) {
      expect(() => adapterFor(host, limits)).toThrow(RangeError);
    }
  });
});
