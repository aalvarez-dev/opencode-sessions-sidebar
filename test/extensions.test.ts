import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createExtensionRuntime, parseExtensionConfigs } from "../src/extensions";
import type { ExtensionContext, SidebarExtension } from "../src/extensions";
import { createOrganizationService } from "../src/organization";
import type { OrganizationDocument, OrganizationResult, StoragePort } from "../src/organization";

const scope = { hostId: "synthetic-host", projectId: "synthetic-project" };
const moduleURL = "file:///synthetic/extension.mjs";
const session = {
  id: "one",
  title: "Synthetic session",
  activity: "idle" as const,
  permissions: 0,
  questions: 0,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function until(check: () => boolean) {
  for (let n = 0; n < 100; n++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Asynchronous condition not observed.");
}
async function service(listenerTimeoutMs = 1_000) {
  let document: OrganizationDocument | undefined;
  const storage: StoragePort = {
    async read() {
      return document ? { status: "loaded", value: document } : { status: "missing" };
    },
    async compareAndSwap(_scope, expected, next) {
      if (expected !== (document?.revision ?? null)) return { status: "conflict" };
      document = next;
      return { status: "written", acknowledgement: "atomic-replace" };
    },
  };
  const organization = createOrganizationService({ scope, storage, limits: { listenerTimeoutMs } });
  await organization.start();
  return organization;
}
async function fixture(definition: SidebarExtension, timeoutMs = 500) {
  const organization = await service();
  const notices: string[] = [];
  let changes = 0;
  const runtime = createExtensionRuntime({
    configs: [{ module: moduleURL }],
    importer: async () => ({ default: definition }),
    timeoutMs,
    changed: () => {
      changes++;
    },
    notify: (message) => notices.push(message),
  });
  runtime.attach(organization, (id) => (id === session.id ? session : undefined));
  await runtime.start();
  return {
    runtime,
    organization,
    notices,
    changes: () => changes,
    dispose() {
      runtime.dispose();
      organization.dispose();
    },
  };
}
const extension = (run: (context: ExtensionContext) => void | Promise<void>): SidebarExtension => ({
  apiVersion: 1,
  id: "synthetic",
  actions: [{ id: "action", title: "Synthetic action", run }],
});

describe("explicit extension contract", () => {
  test("the real local importer preserves actions after native-style asynchronous event observers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sidebar-extension-import-"));
    const module = join(directory, "fixture.mjs");
    const events = join(directory, "events.jsonl");
    const output = join(directory, "report.json");
    await writeFile(
      module,
      `
import { appendFile, writeFile } from "node:fs/promises";
export default {
  apiVersion: 1,
  id: "real-import",
  actions: [{ id: "report", title: "Synthetic extension report", async run(context) {
    const result = await context.dispatch({type:"set-pin",sessionId:context.session.id,pinned:true});
    await writeFile(${JSON.stringify(output)},JSON.stringify(result));
  }}],
  async onEvent(event) { await appendFile(${JSON.stringify(events)},JSON.stringify(event)+"\\n"); }
};
`,
    );
    const organization = await service();
    const messages: string[] = [];
    const runtime = createExtensionRuntime({
      configs: [{ module: pathToFileURL(module).href }],
      changed() {},
      notify(message) {
        messages.push(message);
      },
    });
    try {
      runtime.attach(organization, () => session);
      await runtime.start();
      expect(runtime.diagnostics()[0]!.state).toBe("ready");
      for (const [i, action] of [
        { type: "set-completion" as const, sessionId: "one", done: true },
        { type: "set-pin" as const, sessionId: "one", pinned: true },
        { type: "add-later" as const, sessionId: "one" },
      ].entries()) {
        await organization.dispatch({
          ...action,
          commandId: `user-${i}`,
          expectedRevision: i,
          origin: { type: "user" },
        });
      }
      await until(() => organization.snapshot().pendingDeliveries === 0);
      expect(runtime.diagnostics()[0]!.state).toBe("ready");
      expect(runtime.actions("one")[0]!.title).toBe("Synthetic extension report");
      expect(await runtime.run("real-import:report", "one")).toBe(true);
      expect(JSON.parse(await readFile(output, "utf8")).status).toBe("noop");
      expect((await readFile(events, "utf8")).trim().split("\n")).toHaveLength(3);
      expect(messages).toEqual([]);
    } finally {
      runtime.dispose();
      organization.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
  test("accepts only bounded local JavaScript entries, never network or package names", () => {
    expect(parseExtensionConfigs(undefined)).toEqual([]);
    expect(parseExtensionConfigs([{ module: moduleURL, enabled: false }])).toEqual([
      { module: moduleURL, enabled: false },
    ]);
    for (const module of [
      "relative.mjs",
      "npm:example",
      "https://example.invalid/module.js",
      "file://host/one.js",
      "file:///one.ts",
      "file:///one.js?q=1",
    ])
      expect(() => parseExtensionConfigs([{ module }])).toThrow();
    expect(() => parseExtensionConfigs([{ module: moduleURL, enabled: "false" }])).toThrow();
    expect(() => parseExtensionConfigs([{ module: moduleURL }, { module: moduleURL }])).toThrow();
    expect(() =>
      parseExtensionConfigs(Array.from({ length: 9 }, (_, i) => ({ module: `file:///${i}.mjs` }))),
    ).toThrow();
  });
  test("disabled modules are not imported; broken and duplicate manifests stay isolated", async () => {
    const imported: string[] = [];
    const runtime = createExtensionRuntime({
      configs: ["disabled", "good", "duplicate", "bad"].map((id) => ({
        module: `file:///${id}.mjs`,
        enabled: id !== "disabled",
      })),
      changed() {},
      notify() {},
      importer: async (url) => {
        imported.push(url);
        return { default: url.includes("bad") ? { apiVersion: 99 } : extension(() => {}) };
      },
    });
    await runtime.start();
    expect(imported).toHaveLength(3);
    expect(runtime.diagnostics().map((d) => d.state)).toEqual([
      "disabled",
      "ready",
      "failed",
      "failed",
    ]);
    runtime.dispose();
  });
  test("immediate disposal prevents a queued module import", async () => {
    let imports = 0;
    const runtime = createExtensionRuntime({
      configs: [{ module: moduleURL }],
      changed() {},
      notify() {},
      importer: async () => {
        imports++;
        return { default: extension(() => {}) };
      },
    });
    const started = runtime.start();
    runtime.dispose();
    await started;
    expect(imports).toBe(0);
    expect(runtime.pending().imports).toBe(0);
  });
  test("successful sync and async handlers return success and lose command authority", async () => {
    for (const asyncHandler of [false, true]) {
      let captured!: ExtensionContext;
      const f = await fixture(
        extension(
          asyncHandler
            ? async (context) => {
                captured = context;
              }
            : (context) => {
                captured = context;
              },
        ),
      );
      try {
        expect(await f.runtime.run("synthetic:action", "one")).toBe(true);
        expect(captured.signal.aborted).toBe(true);
        expect(
          (await captured.dispatch({ type: "set-pin", sessionId: "one", pinned: true })).status,
        ).toBe("unavailable");
        expect(f.organization.snapshot().document!.revision).toBe(0);
      } finally {
        f.dispose();
      }
    }
  });
  test("awaited commands preserve extension origin and chain only their own revisions", async () => {
    const results: OrganizationResult[] = [];
    let replayEvents = 0;
    const definition = extension(async (context) => {
      results.push(await context.dispatch({ type: "set-pin", sessionId: "one", pinned: true }));
      results.push(await context.dispatch({ type: "add-later", sessionId: "one" }));
      results.push(
        await context.dispatch({ type: "set-completion", sessionId: "one", done: true }),
      );
    });
    const f = await fixture({
      ...definition,
      onEvent() {
        replayEvents++;
      },
    });
    try {
      expect(f.runtime.actions("one")[0]?.id).toBe("synthetic:action");
      expect(await f.runtime.run("synthetic:action", "one")).toBe(true);
      expect(results.map((r) => r.status)).toEqual(["committed", "committed", "committed"]);
      expect(f.organization.snapshot().document!.revision).toBe(3);
      expect(f.organization.snapshot().document!.pins).toHaveLength(1);
      expect(f.organization.snapshot().document!.later).toHaveLength(1);
      expect(f.organization.snapshot().document!.completionStates[0]!.done).toBe(true);
      await f.organization.refresh();
      expect(replayEvents).toBe(0);
    } finally {
      f.dispose();
    }
  });
  test("concurrent user edits refuse stale extension commands", async () => {
    const gate = deferred<void>();
    let context!: ExtensionContext;
    let outcome!: OrganizationResult;
    const f = await fixture(
      extension(async (value) => {
        context = value;
        await gate.promise;
        outcome = await value.dispatch({ type: "set-completion", sessionId: "one", done: true });
      }),
    );
    try {
      const pending = f.runtime.run("synthetic:action", "one");
      await until(() => !!context);
      await f.organization.dispatch({
        commandId: "user-pin",
        expectedRevision: 0,
        origin: { type: "user" },
        type: "set-pin",
        sessionId: "one",
        pinned: true,
      });
      gate.resolve();
      await pending;
      expect(outcome.status).toBe("stale");
      expect(f.organization.snapshot().document!.completionStates).toEqual([]);
      expect(f.organization.snapshot().document!.pins).toHaveLength(1);
    } finally {
      gate.resolve();
      f.dispose();
    }
  });
  test("fire-and-forget commands are revoked before their queued transition", async () => {
    let pending!: Promise<OrganizationResult>;
    const f = await fixture(
      extension((context) => {
        pending = context.dispatch({ type: "set-pin", sessionId: "one", pinned: true });
      }),
    );
    try {
      await f.runtime.run("synthetic:action", "one");
      expect((await pending).status).toBe("unavailable");
      expect(f.organization.snapshot().document!.revision).toBe(0);
    } finally {
      f.dispose();
    }
  });
  test("scope changes revoke old callbacks and late failures cannot disable the new scope", async () => {
    const gate = deferred<void>();
    let captured!: ExtensionContext;
    const f = await fixture(
      extension(async (context) => {
        captured = context;
        await gate.promise;
      }),
    );
    const next = await service();
    try {
      const pending = f.runtime.run("synthetic:action", "one");
      await until(() => !!captured);
      f.runtime.attach(next, () => session);
      expect(await pending).toBe(false);
      expect(captured.signal.aborted).toBe(true);
      expect(
        (await captured.dispatch({ type: "set-pin", sessionId: "one", pinned: true })).status,
      ).toBe("unavailable");
      gate.reject(new Error("late old-scope failure"));
      await until(() => f.runtime.pending().callbacks === 0);
      expect(f.runtime.diagnostics()[0]!.state).toBe("ready");
      expect(next.snapshot().document!.revision).toBe(0);
      expect(f.notices).toEqual([]);
    } finally {
      gate.resolve();
      f.dispose();
      next.dispose();
    }
  });
  test("timed-out noncooperative work retains capacity and disables its extension", async () => {
    const gate = deferred<void>();
    let captured!: ExtensionContext;
    const f = await fixture(
      extension(async (context) => {
        captured = context;
        await gate.promise;
      }),
      10,
    );
    try {
      expect(await f.runtime.run("synthetic:action", "one")).toBe(false);
      expect(captured.signal.aborted).toBe(true);
      expect(f.runtime.pending().callbacks).toBe(1);
      expect(f.runtime.diagnostics()[0]!.state).toBe("failed");
      expect(await f.runtime.run("synthetic:action", "one")).toBe(false);
      gate.resolve();
      await until(() => f.runtime.pending().callbacks === 0);
    } finally {
      gate.resolve();
      f.dispose();
    }
  });
  test("hanging imports load once across scopes and cannot register after timeout", async () => {
    const gate = deferred<{ default: unknown }>();
    let imports = 0;
    const runtime = createExtensionRuntime({
      configs: [{ module: moduleURL }],
      timeoutMs: 10,
      changed() {},
      notify() {},
      importer: () => {
        imports++;
        return gate.promise;
      },
    });
    const organization = await service();
    try {
      runtime.attach(organization, () => session);
      await runtime.start();
      for (let n = 0; n < 10; n++) runtime.attach(organization, () => session);
      expect(imports).toBe(1);
      expect(runtime.pending().imports).toBe(1);
      gate.resolve({ default: extension(() => {}) });
      await until(() => runtime.pending().imports === 0);
      expect(runtime.diagnostics()[0]!.state).toBe("failed");
      expect(runtime.actions("one")).toEqual([]);
    } finally {
      gate.resolve({ default: undefined });
      runtime.dispose();
      organization.dispose();
    }
  });
  test("noncooperative callbacks cannot accumulate across repeated scope changes", async () => {
    const gate = deferred<void>();
    let calls = 0;
    const f = await fixture(
      extension(async () => {
        calls++;
        await gate.promise;
      }),
    );
    try {
      for (let n = 0; n < 8; n++) {
        const pending = f.runtime.run("synthetic:action", "one");
        await until(() => calls === n + 1);
        f.runtime.attach(f.organization, () => session);
        expect(await pending).toBe(false);
      }
      expect(f.runtime.pending().callbacks).toBe(8);
      expect(await f.runtime.run("synthetic:action", "one")).toBe(false);
      expect(calls).toBe(8);
      gate.resolve();
      await until(() => f.runtime.pending().callbacks === 0);
      expect(f.runtime.actions("one")[0]!.enabled).toBe(true);
    } finally {
      gate.resolve();
      f.dispose();
    }
  });
  test("event handlers see commits but hydration and extension commands do not loop", async () => {
    let observed = 0;
    const f = await fixture({
      apiVersion: 1,
      id: "listener",
      async onEvent(event, context) {
        observed++;
        expect(event.origin.type).toBe("user");
        expect(context.expectedRevision).toBe(event.revision);
        await context.dispatch({ type: "add-later", sessionId: "one" });
      },
    });
    try {
      expect(observed).toBe(0);
      await f.organization.dispatch({
        commandId: "pin",
        expectedRevision: 0,
        origin: { type: "user" },
        type: "set-pin",
        sessionId: "one",
        pinned: true,
      });
      await until(() => f.organization.snapshot().document!.later.length === 1);
      await f.organization.refresh();
      expect(observed).toBe(1);
      expect(f.runtime.diagnostics()[0]!.state).toBe("ready");
    } finally {
      f.dispose();
    }
  });
  test("the coordinator's shorter listener timeout surfaces failure and keeps the user commit", async () => {
    const gate = deferred<void>();
    const organization = await service(10);
    const runtime = createExtensionRuntime({
      configs: [{ module: moduleURL }],
      timeoutMs: 100,
      changed() {},
      notify() {},
      importer: async () => ({
        default: {
          apiVersion: 1,
          id: "slow",
          onEvent: () => gate.promise,
        },
      }),
    });
    try {
      runtime.attach(organization, () => session);
      await runtime.start();
      await organization.dispatch({
        commandId: "pin",
        expectedRevision: 0,
        origin: { type: "user" },
        type: "set-pin",
        sessionId: "one",
        pinned: true,
      });
      await until(() => runtime.diagnostics()[0]!.state === "failed");
      expect(organization.snapshot().document!.pins).toHaveLength(1);
      expect(organization.snapshot().subscribers).toBe(0);
      expect(runtime.pending().callbacks).toBe(1);
      gate.resolve();
      await until(() => runtime.pending().callbacks === 0);
    } finally {
      gate.resolve();
      runtime.dispose();
      organization.dispose();
    }
  });
  test("predicates fail closed, missing sessions and forged execution evidence are refused", async () => {
    let forged!: OrganizationResult;
    const f = await fixture(
      extension(async (context) => {
        forged = await context.dispatch({
          type: "set-completion",
          sessionId: "one",
          done: true,
          executionSequence: 5,
        });
      }),
    );
    try {
      expect(f.runtime.actions("missing")).toEqual([]);
      expect(await f.runtime.run("synthetic:action", "missing")).toBe(false);
      await f.runtime.run("synthetic:action", "one");
      expect(forged.status).toBe("invalid");
      expect(f.organization.snapshot().document!.revision).toBe(0);
    } finally {
      f.dispose();
    }
    const broken = await fixture({
      apiVersion: 1,
      id: "bad",
      actions: [
        {
          id: "bad",
          title: "Broken",
          run() {},
          visible() {
            throw new Error();
          },
        },
      ],
    });
    try {
      expect(broken.runtime.actions("one")).toEqual([]);
      expect(broken.runtime.diagnostics()[0]!.state).toBe("failed");
    } finally {
      broken.dispose();
    }
  });
  test("malformed and rejected async predicates disable the module without an unhandled rejection", async () => {
    const invalid = [
      () => null,
      () => undefined,
      async () => {
        throw new Error("must be contained");
      },
    ];
    for (const visible of invalid) {
      const f = await fixture({
        apiVersion: 1,
        id: "bad-predicate",
        actions: [
          {
            id: "action",
            title: "Invalid predicate",
            run() {},
            visible: visible as unknown as () => boolean,
          },
        ],
      });
      try {
        expect(f.runtime.actions("one")).toEqual([]);
        expect(f.runtime.diagnostics()[0]!.state).toBe("failed");
        await new Promise((resolve) => setTimeout(resolve, 1));
        expect(f.organization.snapshot().document!.revision).toBe(0);
      } finally {
        f.dispose();
      }
    }
  });
});
