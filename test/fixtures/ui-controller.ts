import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRoot } from "solid-js";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { Event, Session, SessionStatus } from "@opencode-ai/sdk/v2";
import { createSidebarController, parseSidebarOptions } from "../../src/ui/controller";
import { createFileStorage } from "../../src/storage/file";

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => (resolve = yes));
  return { promise, resolve };
}

export function syntheticSession(
  id: string,
  directory = "/example/one",
  projectID = "project-one",
): Session {
  return {
    id,
    slug: id,
    title: `Session ${id}`,
    directory,
    projectID,
    version: "test",
    time: { created: 1, updated: 1 },
  };
}

/** Public-port fixture; deliberately noncooperative requests exercise disposal guards. */
export class ControllerHost {
  directory = "/example/one";
  worktree = "/example/one";
  branch: string | undefined = "main";
  sessions = [syntheticSession("one")];
  calls = { project: 0, list: 0, status: 0, permissions: 0, questions: 0, create: 0 };
  toasts: { message: string; variant: string }[] = [];
  navigations: unknown[] = [];
  currentRoute: { name: string; params?: { sessionID: string } } = { name: "home" };
  handlers = new Map<Event["type"], Set<(event: Event) => void>>();
  disposers = new Set<() => void | Promise<void>>();
  lifetime = new AbortController();
  lookupSignals: AbortSignal[] = [];
  projectRead: (directory: string) => Promise<{ id: string; worktree?: string; vcs?: "git" }> =
    async (directory) => ({
      id: directory.endsWith("two") ? "project-two" : "project-one",
      worktree: directory,
      vcs: "git",
    });
  createWrite: () => Promise<Session> = async () => syntheticSession("created");
  listRead: (directory: string) => Promise<Session[]> = async (directory) =>
    this.sessions.filter((session) => session.directory === directory);

  get api(): TuiPluginApi {
    const host = this;
    // Generated SDK methods are polymorphic. This fixture implements only the public
    // fields envelope used here; production compatibility is checked against its full type.
    return {
      client: {
        global: { health: async () => ({ data: { healthy: true, version: "test" } }) },
        project: {
          current: async (parameters: { directory: string }, options: { signal: AbortSignal }) => {
            host.calls.project++;
            host.lookupSignals.push(options.signal);
            return { data: await host.projectRead(parameters.directory) };
          },
        },
        session: {
          list: async (parameters: { directory: string }) => {
            host.calls.list++;
            return {
              data: await host.listRead(parameters.directory),
            };
          },
          status: async () => {
            host.calls.status++;
            return { data: {} };
          },
          create: async () => {
            host.calls.create++;
            return { data: await host.createWrite() };
          },
          update: async () => ({ data: undefined }),
          delete: async () => ({ data: true }),
        },
        permission: {
          list: async () => {
            host.calls.permissions++;
            return { data: [] };
          },
        },
        question: {
          list: async () => {
            host.calls.questions++;
            return { data: [] };
          },
        },
      },
      event: {
        on(type: Event["type"], callback: (event: Event) => void) {
          const handlers = host.handlers.get(type) ?? new Set();
          handlers.add(callback);
          host.handlers.set(type, handlers);
          return () => handlers.delete(callback);
        },
      },
      lifecycle: {
        signal: host.lifetime.signal,
        onDispose(callback: () => void | Promise<void>) {
          host.disposers.add(callback);
          return () => host.disposers.delete(callback);
        },
      },
      route: {
        get current() {
          return host.currentRoute;
        },
        navigate(name: string, params: unknown) {
          host.navigations.push({ name, params });
        },
      },
      state: {
        path: {
          get directory() {
            return host.directory;
          },
          get worktree() {
            return host.worktree;
          },
        },
        get vcs() {
          return { branch: host.branch };
        },
      },
      ui: {
        toast(input: { message: string; variant: string }) {
          host.toasts.push(input);
        },
      },
    } as unknown as TuiPluginApi;
  }

  emit(event: Event) {
    for (const handler of this.handlers.get(event.type) ?? []) handler(event);
  }

  status(eventId: string, sessionID: string, status: SessionStatus) {
    this.emit({ id: eventId, type: "session.status", properties: { sessionID, status } });
  }

  get subscriptions() {
    return [...this.handlers.values()].reduce((sum, handlers) => sum + handlers.size, 0);
  }
}

export async function controllerFixture() {
  const storageDirectory = await mkdtemp(join(tmpdir(), "sidebar-controller-"));
  const host = new ControllerHost();
  let disposeRoot = () => {};
  const controller = createRoot((dispose) => {
    disposeRoot = dispose;
    return createSidebarController(host.api, { hostId: "test-host", storageDirectory });
  });
  return {
    host,
    controller,
    storageDirectory,
    async dispose() {
      controller.dispose();
      disposeRoot();
      await rm(storageDirectory, { recursive: true, force: true });
    },
  };
}

async function ready() {
  const fixture = await controllerFixture();
  const { host, controller, storageDirectory } = fixture;
  try {
    await controller.connect(host.directory);
    assert.equal(controller.state()?.phase, "ready");
    assert.equal(controller.organizationState()?.phase, "ready");
    assert.equal(controller.error(), null);
    assert.deepEqual(
      controller.rows().map((row) => row.session.id),
      ["one"],
    );
    await controller.organize(
      { type: "set-pin", sessionId: "one", pinned: true },
      controller.document()!.revision,
    );
    assert.equal(controller.document()!.revision, 1);
    assert.equal(
      controller.groups().find((group) => group.id === "pins")!.rows[0]!.session.id,
      "one",
    );
    assert.equal(controller.rows()[0]!.pinned, true);
    const saved = await createFileStorage({ directory: storageDirectory }).read({
      hostId: "test-host",
      projectId: "project-one",
    });
    assert.equal(saved.status, "loaded");
    assert.equal(host.toasts.at(-1)?.variant, "success");
  } finally {
    await fixture.dispose();
  }
}

async function modelInvalidation() {
  const fixture = await controllerFixture();
  const { host, controller } = fixture;
  try {
    host.sessions = [
      syntheticSession("parent"),
      { ...syntheticSession("child"), parentID: "parent" },
      ...Array.from({ length: 248 }, (_, index) => syntheticSession(`other-${index}`)),
    ];
    await controller.connect(host.directory);
    const initialRows = controller.rows();
    const initialGroups = controller.groups();
    const initialDocument = controller.document();
    assert.equal(initialRows.length, 250);

    // Pending/no-op organization work must not reconstruct the loaded session model.
    const unchanged = controller.organize(
      { type: "set-pin", sessionId: "parent", pinned: false },
      initialDocument!.revision,
    );
    assert.equal(controller.pending(), true);
    assert.equal(controller.groups(), initialGroups);
    await unchanged;
    assert.equal(controller.pending(), false);
    assert.equal(controller.document(), initialDocument);
    assert.equal(controller.rows(), initialRows);
    assert.equal(controller.groups(), initialGroups);

    // Coverage diagnostics remain reactive even when no loaded row changes.
    host.emit({
      id: "unloaded-question",
      type: "question.asked",
      properties: { id: "unloaded", sessionID: "outside", questions: [] },
    });
    assert.equal(controller.state()?.attentionCoverage, "partial");
    assert.match(controller.state()?.diagnostic ?? "", /unscoped session/);
    assert.equal(controller.rows(), initialRows);
    assert.equal(controller.groups(), initialGroups);

    const snapshot = deferred<Session[]>();
    host.listRead = () => snapshot.promise;
    const refreshing = controller.refresh();
    await Promise.resolve();
    assert.equal(controller.state()?.phase, "loading");
    assert.equal(controller.state()?.refreshing, true);
    assert.equal(controller.document(), initialDocument);
    assert.equal(controller.rows(), initialRows);
    assert.equal(controller.groups(), initialGroups);
    snapshot.resolve(host.sessions);
    await refreshing;
    assert.equal(controller.state()?.phase, "ready");
    assert.equal(controller.state()?.refreshing, false);
    assert.equal(controller.state()?.attentionCoverage, "complete");
    // Organization refresh creates a new document: that is a legitimate model input.
    assert.notEqual(controller.document(), initialDocument);
    assert.notEqual(controller.groups(), initialGroups);
    assert.ok(controller.rows().every((row, index) => row === initialRows[index]));

    const beforeAttention = controller.groups();
    host.emit({
      id: "child-question",
      type: "question.asked",
      properties: { id: "question", sessionID: "child", questions: [] },
    });
    assert.notEqual(controller.groups(), beforeAttention);
    assert.equal(
      controller.rows().find((row) => row.session.id === "parent")?.summary.questions,
      1,
    );
    assert.equal(controller.liveChildrenFor("parent")[0]?.session.id, "child");
    await controller.organize(
      { type: "set-pin", sessionId: "child", pinned: true },
      controller.document()!.revision,
    );
    assert.equal(
      controller.groups().find((group) => group.id === "pins")?.rows[0]?.session.id,
      "child",
    );
    host.currentRoute = { name: "session", params: { sessionID: "child" } };
    controller.observeRoute();
    assert.equal(controller.activeRow()?.session.id, "child");
    assert.equal(controller.activeRow()?.summary.questions, 1);
    assert.equal(controller.groups().find((group) => group.id === "pins")?.rows.length, 0);
    const selectedGroups = controller.groups();
    controller.observeRoute();
    assert.equal(controller.groups(), selectedGroups);

    // Loss of certainty changes row activity and ancestor summaries immediately.
    host.emit({ id: "reconnected", type: "server.connected", properties: {} });
    assert.equal(controller.state()?.phase, "stale");
    assert.equal(controller.state()?.attentionCoverage, "unknown");
    assert.equal(controller.activeRow()?.session.activity, "unknown");
    assert.equal(controller.rows().find((row) => row.session.id === "parent")?.summary.unknown, 2);
    assert.equal(controller.activeRow()?.summary.questions, 1);
    await controller.refresh();
    assert.equal(controller.state()?.phase, "ready");
    assert.equal(controller.activeRow()?.session.activity, "idle");
  } finally {
    await fixture.dispose();
  }
}

async function staleGuard() {
  const fixture = await controllerFixture();
  const { host, controller } = fixture;
  try {
    await controller.connect(host.directory);
    let invocations = 0;
    const oldAction = controller.guard(() => {
      invocations++;
      void controller.organize(
        { type: "set-pin", sessionId: "two", pinned: true },
        controller.document()!.revision,
      );
    });
    host.directory = "/example/two";
    host.sessions = [syntheticSession("two", host.directory, "project-two")];
    await controller.connect(host.directory);
    oldAction();
    assert.equal(invocations, 0);
    assert.equal(controller.document()!.scope.projectId, "project-two");
    assert.deepEqual(controller.document()!.pins, []);
    assert.equal(host.toasts.at(-1)?.variant, "warning");
    assert.equal(controller.pending(), false);
  } finally {
    await fixture.dispose();
  }
}

async function disposed() {
  const fixture = await controllerFixture();
  const { host, controller } = fixture;
  try {
    await controller.connect(host.directory);
    assert.ok(host.subscriptions > 0);
    const write = deferred<Session>();
    host.createWrite = () => write.promise;
    const operation = controller.native("create", undefined, "Delayed creation");
    assert.equal(host.calls.create, 1);
    controller.dispose();
    assert.equal(host.subscriptions, 0);
    assert.equal(host.disposers.size, 0);
    const toasts = host.toasts.length;
    write.resolve(syntheticSession("late-created"));
    await operation;
    host.status("late-status", "one", { type: "busy" });
    assert.equal(controller.active(), false);
    assert.equal(controller.document(), null);
    assert.deepEqual(controller.rows(), []);
    assert.deepEqual(host.navigations, []);
    assert.equal(host.toasts.length, toasts);
  } finally {
    await fixture.dispose();
  }
}

async function boundedLookup() {
  const fixture = await controllerFixture();
  const { host, controller } = fixture;
  try {
    const lookup = deferred<{ id: string }>();
    host.projectRead = () => lookup.promise;
    const first = controller.connect(host.directory);
    await controller.connect("/example/two");
    await controller.connect("/example/three");
    await controller.refresh();
    assert.equal(host.calls.project, 1);
    assert.equal(host.lookupSignals[0]!.aborted, true);
    assert.equal(controller.connecting(), false);
    assert.match(controller.error()!, /still finishing/);
    controller.dispose();
    lookup.resolve({ id: "late-project" });
    await first;
    assert.equal(host.calls.project, 1);
    assert.equal(host.calls.list, 0);
    assert.equal(host.subscriptions, 0);
    assert.equal(controller.document(), null);
  } finally {
    await fixture.dispose();
  }
}

async function hierarchy() {
  const fixture = await controllerFixture();
  const { host, controller } = fixture;
  try {
    host.sessions = [
      syntheticSession("parent"),
      { ...syntheticSession("child"), parentID: "parent" },
    ];
    await controller.connect(host.directory);
    assert.deepEqual(
      controller.rows().map((row) => row.session.id),
      ["child", "parent"],
    );
    assert.deepEqual(
      controller.groups()[2]!.rows.map((row) => row.session.id),
      ["parent"],
    );
    assert.equal(controller.childrenFor("parent")[0]!.session.id, "child");
    assert.equal(controller.liveChildrenFor("parent").length, 0);
    host.status("child-started", "child", { type: "busy" });
    assert.equal(controller.liveChildrenFor("parent")[0]!.session.id, "child");
    controller.toggleChildren("parent");
    controller.toggleGroup("pins");
    assert.equal(controller.expandedChildren().has("parent"), true);
    controller.toggleChildren("missing");
    assert.equal(controller.expandedChildren().size, 1);
    await controller.organize(
      { type: "set-pin", sessionId: "child", pinned: true },
      controller.document()!.revision,
    );
    await controller.organize(
      { type: "add-later", sessionId: "child" },
      controller.document()!.revision,
    );
    const before = controller.document();
    assert.equal(controller.groups()[0]!.rows[0]!.session.id, "child");
    assert.equal(controller.groups()[1]!.rows.length, 0);
    controller.open("child");
    assert.deepEqual(host.navigations.at(-1), { name: "session", params: { sessionID: "child" } });
    host.currentRoute = { name: "session", params: { sessionID: "child" } };
    controller.observeRoute();
    assert.equal(controller.activeRow()?.session.id, "child");
    assert.equal(controller.activeRow()?.pinned, true);
    assert.equal(controller.activeRow()?.later, true);
    assert.equal(controller.groups()[0]!.rows.length, 0);
    assert.equal(controller.document(), before);
    assert.equal(controller.rows().length, 2);
    host.currentRoute = { name: "home" };
    controller.observeRoute();
    assert.equal(controller.activeRow(), undefined);
    assert.equal(controller.groups()[0]!.rows[0]!.session.id, "child");
    assert.equal(controller.document(), before);

    host.status("child-idle", "child", { type: "idle" });
    assert.equal(controller.liveChildrenFor("parent").length, 0);
    assert.equal(controller.childrenFor("parent").length, 1);

    // Identical native IDs in another scope never inherit disclosure or selection state.
    host.directory = "/example/two";
    host.sessions = [syntheticSession("parent", host.directory, "project-two")];
    await controller.connect(host.directory);
    assert.equal(controller.expandedChildren().size, 0);
    assert.equal(controller.collapsed().size, 0);
    assert.equal(controller.childrenFor("parent").length, 0);
    assert.equal(controller.activeRow(), undefined);
    assert.deepEqual(controller.laterIds(), []);
  } finally {
    await fixture.dispose();
  }
}

async function activeChildren() {
  const fixture = await controllerFixture();
  const { host, controller } = fixture;
  const select = (id: string) => {
    host.currentRoute = { name: "session", params: { sessionID: id } };
    controller.observeRoute();
  };
  try {
    host.sessions = [
      syntheticSession("first"),
      syntheticSession("second"),
      { ...syntheticSession("first-child"), parentID: "first" },
      { ...syntheticSession("second-child"), parentID: "second" },
    ];
    // Selection exists before hydration; children can begin work after that snapshot.
    host.currentRoute = { name: "session", params: { sessionID: "first" } };
    await controller.connect(host.directory);
    assert.equal(controller.activeRow()?.session.id, "first");
    assert.equal(controller.liveChildrenFor("first").length, 0);
    host.status("first-started", "first-child", { type: "busy" });
    host.status("second-started", "second-child", { type: "busy" });
    assert.equal(controller.expandedChildren().has("first"), true);
    assert.equal(controller.expandedChildren().has("second"), false);
    const calls = { ...host.calls };

    // Without a user choice, disclosure follows the currently selected session.
    select("second");
    assert.equal(controller.expandedChildren().has("first"), false);
    assert.equal(controller.expandedChildren().has("second"), true);
    controller.toggleChildren("second");
    assert.equal(controller.expandedChildren().has("second"), false);
    select("first");
    select("second");
    assert.equal(controller.expandedChildren().has("second"), false);

    // Explicit opening also survives switching away; it is not a second default.
    controller.toggleChildren("second");
    select("first");
    assert.equal(controller.expandedChildren().has("first"), true);
    assert.equal(controller.expandedChildren().has("second"), true);
    controller.toggleChildren("first");
    assert.equal(controller.expandedChildren().has("first"), false);
    assert.deepEqual(host.calls, calls);

    // A fresh snapshot or newly arriving work must not override an explicit collapse.
    await controller.refresh();
    assert.equal(controller.expandedChildren().has("first"), false);
    assert.equal(controller.expandedChildren().has("second"), true);
    const lateChild = { ...syntheticSession("late-child"), parentID: "first" };
    host.sessions.push(lateChild);
    host.emit({
      id: "late-created",
      type: "session.created",
      properties: { sessionID: lateChild.id, info: lateChild },
    });
    host.status("late-started", "late-child", { type: "busy" });
    assert.equal(controller.liveChildrenFor("first")[0]?.session.id, "late-child");
    assert.equal(controller.expandedChildren().has("first"), false);

    // Deleted choices are discarded rather than retaining an expanded orphan.
    host.emit({
      id: "second-deleted",
      type: "session.deleted",
      properties: { sessionID: "second", info: host.sessions[1]! },
    });
    assert.equal(controller.expandedChildren().has("second"), false);

    // A different project never inherits the previous project's explicit collapse.
    host.directory = "/example/two";
    host.sessions = [
      syntheticSession("first", host.directory, "project-two"),
      {
        ...syntheticSession("first-child", host.directory, "project-two"),
        parentID: "first",
      },
    ];
    await controller.connect(host.directory);
    assert.equal(controller.activeRow()?.session.id, "first");
    assert.equal(controller.expandedChildren().has("first"), true);
    host.status("new-scope-started", "first-child", { type: "busy" });
    assert.equal(controller.liveChildrenFor("first").length, 1);
    assert.equal(controller.expandedChildren().has("first"), true);

    controller.dispose();
    controller.toggleChildren("first");
    host.status("after-disposal", "first-child", { type: "busy" });
    assert.equal(controller.expandedChildren().size, 0);
    assert.equal(host.subscriptions, 0);
  } finally {
    await fixture.dispose();
  }
}

async function context() {
  const fixture = await controllerFixture();
  const { host, controller } = fixture;
  try {
    const repository = "/remote/" + "repository-".repeat(25);
    host.worktree = "/remote/worktrees/feature";
    host.branch = "feature/" + "context-".repeat(25);
    host.projectRead = async () => ({ id: "project-one", vcs: "git", worktree: repository });
    await controller.connect(host.directory);
    const calls = { ...host.calls };
    const before = controller.document();
    assert.deepEqual(controller.context(), {
      repository,
      branch: host.branch,
      worktree: host.worktree,
    });
    assert.equal(controller.contextField("one"), "repository");
    controller.selectContext("one", "branch");
    assert.equal(controller.contextField("one"), "branch");
    assert.equal(controller.expandedContext().has("one"), false);
    controller.toggleContext("one");
    controller.selectContext("one", "worktree");
    assert.equal(controller.expandedContext().has("one"), true);
    assert.equal(controller.contextField("one"), "worktree");
    controller.toggleContext("one");
    assert.equal(controller.expandedContext().has("one"), false);
    assert.equal(controller.contextField("one"), "worktree");
    controller.selectContext("missing", "branch");
    controller.toggleContext("missing");
    assert.equal(controller.contextField("missing"), "repository");
    assert.equal(controller.expandedContext().size, 0);
    assert.equal(controller.document(), before);
    assert.deepEqual(host.navigations, []);
    assert.deepEqual(host.calls, calls);

    // Missing data retains the requested field and does not invent a fallback value.
    host.branch = undefined;
    host.worktree = "";
    controller.selectContext("one", "branch");
    assert.equal(controller.contextField("one"), "branch");
    assert.deepEqual(controller.context(), { repository, branch: null, worktree: null });
    await controller.refresh();
    assert.equal(controller.contextField("one"), "branch");

    controller.toggleContext("one");
    host.emit({
      id: "one-deleted",
      type: "session.deleted",
      properties: { sessionID: "one", info: host.sessions[0]! },
    });
    assert.equal(controller.contextField("one"), "repository");
    assert.equal(controller.expandedContext().size, 0);

    // An arbitrary working directory without host VCS evidence is not a repository.
    host.directory = "/example/two";
    host.worktree = "/example/two";
    host.branch = "stale-branch";
    assert.deepEqual(controller.context(), { repository: null, branch: null, worktree: null });
    host.projectRead = async () => ({ id: "project-two", worktree: host.worktree });
    host.sessions = [syntheticSession("one", host.directory, "project-two")];
    await controller.connect(host.directory);
    assert.equal(controller.contextField("one"), "repository");
    assert.deepEqual(controller.context(), { repository: null, branch: null, worktree: null });
    controller.selectContext("one", "worktree");
    controller.toggleContext("one");
    controller.dispose();
    controller.selectContext("one", "branch");
    controller.toggleContext("one");
    assert.equal(controller.contextField("one"), "repository");
    assert.equal(controller.expandedContext().size, 0);
    assert.deepEqual(controller.context(), { repository: null, branch: null, worktree: null });
  } finally {
    await fixture.dispose();
  }
}

async function options() {
  const valid = {
    hostId: "test",
    storageDirectory: "/example/storage",
    icons: "nerd",
    reducedMotion: true,
  };
  assert.deepEqual(parseSidebarOptions(valid), valid);
  for (const hostId of ["test\0host", "test\nhost", "test\thost", "test\u007fhost"]) {
    assert.throws(() => parseSidebarOptions({ ...valid, hostId }), /hostId/);
  }
  assert.throws(
    () => parseSidebarOptions({ ...valid, storageDirectory: "/example/sto\0rage" }),
    /storageDirectory/,
  );
  assert.throws(() => parseSidebarOptions({ ...valid, reducedMotion: "false" }), /boolean/);
  assert.throws(() => parseSidebarOptions({ ...valid, icons: "invalid" }), /icons/);
  for (const icons of [["nerd"], { toString: () => "ascii" }, null]) {
    assert.throws(() => parseSidebarOptions({ ...valid, icons }), /icons/);
  }
  for (const density of [["compact"], { toString: () => "balanced" }, null]) {
    assert.throws(() => parseSidebarOptions({ ...valid, density }), /density/);
  }
  const fixture = await controllerFixture();
  try {
    assert.equal(fixture.controller.reducedMotion(), false);
    fixture.controller.setReducedMotion(true);
    assert.equal(fixture.controller.reducedMotion(), true);
    fixture.controller.setIcons("nerd");
    assert.equal(fixture.controller.icons(), "nerd");
  } finally {
    await fixture.dispose();
  }
}

if (import.meta.main) {
  const scenario = process.argv[2];
  const scenarios: Record<string, () => Promise<void>> = {
    ready,
    "model-invalidation": modelInvalidation,
    "stale-guard": staleGuard,
    disposed,
    "bounded-lookup": boundedLookup,
    hierarchy,
    "active-children": activeChildren,
    context,
    options,
  };
  const run = scenario ? scenarios[scenario] : undefined;
  if (!run) throw new Error("Choose a controller test scenario.");
  await run();
  process.stdout.write(JSON.stringify({ scenario, passed: true }));
}
