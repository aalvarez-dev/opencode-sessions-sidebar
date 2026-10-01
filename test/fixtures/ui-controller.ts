import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRoot } from "solid-js";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { Event, Session, SessionStatus } from "@opencode-ai/sdk/v2";
import { createSidebarController } from "../../src/ui/controller";
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
  sessions = [syntheticSession("one")];
  calls = { project: 0, list: 0, status: 0, permissions: 0, questions: 0, create: 0 };
  toasts: { message: string; variant: string }[] = [];
  navigations: unknown[] = [];
  handlers = new Map<Event["type"], Set<(event: Event) => void>>();
  disposers = new Set<() => void | Promise<void>>();
  lifetime = new AbortController();
  lookupSignals: AbortSignal[] = [];
  projectRead: (directory: string) => Promise<{ id: string }> = async (directory) => ({
    id: directory.endsWith("two") ? "project-two" : "project-one",
  });
  createWrite: () => Promise<Session> = async () => syntheticSession("created");

  get api(): TuiPluginApi {
    const host = this;
    // Generated SDK methods are polymorphic. This fixture implements only the public
    // fields envelope used here; production compatibility is checked against its full type.
    return {
      client: {
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
              data: host.sessions.filter((session) => session.directory === parameters.directory),
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
        current: { name: "home" },
        navigate(name: string, params: unknown) {
          host.navigations.push({ name, params });
        },
      },
      state: {
        path: {
          get directory() {
            return host.directory;
          },
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
    assert.equal(controller.groups()[0]!.rows[0]!.session.id, "one");
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

if (import.meta.main) {
  const scenario = process.argv[2];
  const scenarios: Record<string, () => Promise<void>> = {
    ready,
    "stale-guard": staleGuard,
    disposed,
    "bounded-lookup": boundedLookup,
  };
  const run = scenario ? scenarios[scenario] : undefined;
  if (!run) throw new Error("Choose a controller test scenario.");
  await run();
  process.stdout.write(JSON.stringify({ scenario, passed: true }));
}
