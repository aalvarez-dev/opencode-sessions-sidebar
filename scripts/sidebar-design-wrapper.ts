/** Test-only public-read visual fixture around the unchanged built product. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import type { QuestionRequest, Session, SessionStatus } from "@opencode-ai/sdk/v2";
import { createOrganizationService } from "../src/organization";
import { createFileStorage } from "../src/storage/file";
import { designLimitations, designSessions } from "./sidebar-design-fixture";

function forward<T extends object>(source: T, overrides: Record<string, unknown>): T {
  // Empty target avoids invariants on frozen host APIs. Unchanged methods retain their receiver.
  return new Proxy(Object.create(null), {
    get(_target, key) {
      if (typeof key === "string" && Object.hasOwn(overrides, key)) return overrides[key];
      const value = Reflect.get(source, key, source);
      return typeof value === "function" ? value.bind(source) : value;
    },
    has(_target, key) {
      return key in overrides || key in source;
    },
  }) as T;
}

export default {
  id: "opencode-sessions-sidebar",
  async tui(api, options, context) {
    assert.equal(
      process.env.SIDEBAR_DESIGN,
      "true",
      "This wrapper is only for the isolated visual fixture.",
    );
    assert.equal(api.app.version, "1.18.30");
    const productPath = process.env.SIDEBAR_DESIGN_PRODUCT;
    const exchange = process.env.SIDEBAR_SMOKE_EXCHANGE;
    const directory = process.env.SIDEBAR_SMOKE_DIRECTORY;
    const storageDirectory = process.env.SIDEBAR_SMOKE_STORAGE;
    assert(productPath && exchange && directory && storageDirectory && options);
    const project = await api.client.project.current({ directory });
    assert(project.data);
    const ids: Record<string, string> = {};
    const sessions: Session[] = [];
    const origin = Date.now();
    for (const [index, entry] of designSessions.entries()) {
      const parentID = "parent" in entry ? ids[entry.parent] : undefined;
      const created: { data: Session | undefined } = await api.client.session.create({
        directory,
        title: entry.title,
        agent: entry.agent,
        ...(parentID ? { parentID } : {}),
      });
      assert(created.data);
      ids[entry.key] = created.data.id;
      sessions.push({
        ...created.data,
        // One-millisecond stable ordering preserves the approved security/backend order.
        time: { ...created.data.time, updated: origin - entry.minutes * 60_000 - index },
      });
    }
    const service = createOrganizationService({
      scope: { hostId: String(options.hostId), projectId: project.data.id },
      storage: createFileStorage({ directory: storageDirectory }),
    });
    await service.start();
    for (const [index, action] of [
      { type: "set-completion" as const, sessionId: ids.release!, done: true },
      { type: "set-completion" as const, sessionId: ids.review!, done: true },
      { type: "set-pin" as const, sessionId: ids.review!, pinned: true },
      { type: "add-later" as const, sessionId: ids.branches! },
    ].entries()) {
      const result = await service.dispatch({
        ...action,
        commandId: `design-${index}`,
        expectedRevision: service.snapshot().document?.revision ?? 0,
        origin: { type: "user" },
      });
      assert.equal(result.status, "committed");
    }
    service.dispose();
    const statuses: Record<string, SessionStatus> = Object.fromEntries(
      [ids.backend!, ids["review-child"]!].map((id) => [id, { type: "busy" }]),
    );
    const questions: QuestionRequest[] = [
      {
        id: "synthetic-design-question",
        sessionID: ids.security!,
        questions: [
          {
            header: "Design",
            question: "Synthetic visual question",
            options: [{ label: "Continue", description: "Synthetic visual fixture" }],
          },
        ],
      },
    ];
    const session = forward(api.client.session, {
      list: async () => ({ data: sessions }),
      status: async () => ({ data: statuses }),
    });
    const client = forward(api.client, {
      session,
      question: forward(api.client.question, { list: async () => ({ data: questions }) }),
      permission: forward(api.client.permission, { list: async () => ({ data: [] }) }),
    });
    const wrapped = forward(api, { client }) as TuiPluginApi;
    const { default: product } = (await import(pathToFileURL(productPath).href)) as {
      default: TuiPluginModule;
    };
    assert(product.tui);
    await product.tui(wrapped, { ...options, reducedMotion: true }, context);
    api.route.navigate("session", { sessionID: ids.release! });
    await writeFile(
      `${exchange}.design.json`,
      JSON.stringify({
        kind: "approved-design-synthetic-public-read-fixture",
        nativeExecutionValidated: false,
        ids,
        sessions,
        statuses,
        questions,
        productSha256: createHash("sha256")
          .update(await readFile(productPath))
          .digest("hex"),
        limitations: designLimitations,
      }),
    );
  },
} satisfies TuiPluginModule;
