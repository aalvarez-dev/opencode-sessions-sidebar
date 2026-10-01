/** Test-only observer; native attention and actual frames from stock OpenCode. */
import assert from "node:assert/strict";
import { readFile, rename, writeFile } from "node:fs/promises";
import type { TuiPluginModule } from "@opencode-ai/plugin/tui";
import { createFileStorage } from "../src/storage/file.js";

interface Request {
  readonly id: number;
  readonly type: "snapshot" | "seed" | "command" | "start" | "reply-question" | "reply-permission";
  readonly command?: string;
}

export default {
  id: "synthetic-sidebar-attention-observer",
  async tui(api) {
    const exchange = process.env.SIDEBAR_ATTENTION_EXCHANGE;
    const directory = process.env.SIDEBAR_ATTENTION_DIRECTORY;
    const storageDirectory = process.env.SIDEBAR_ATTENTION_STORAGE;
    assert(exchange && directory && storageDirectory, "Missing isolated probe environment.");
    assert.equal(api.app.version, "1.18.30");
    const scopeDirectory = directory;
    const storage = createFileStorage({ directory: storageDirectory });
    const project = await api.client.project.current({ directory: scopeDirectory });
    assert(project.data);
    const scope = { hostId: "synthetic-sidebar-attention", projectId: project.data.id };
    let parentId: string | undefined;
    let childId: string | undefined;
    let lastRequest = 0;
    let running = false;
    let closed = false;
    let promptFinished = false;
    let promptError: unknown;
    const events: string[] = [];
    const off = (
      ["question.asked", "question.replied", "permission.asked", "permission.replied"] as const
    ).map((type) =>
      api.event.on(type, () => {
        if (events.length < 64) events.push(type);
      }),
    );

    async function snapshot() {
      if (promptError) throw promptError;
      const [questions, permissions, statuses, organization] = await Promise.all([
        api.client.question.list({ directory: scopeDirectory }),
        api.client.permission.list({ directory: scopeDirectory }),
        api.client.session.status({ directory: scopeDirectory }),
        storage.read(scope),
      ]);
      const frame = api.renderer.currentRenderBuffer;
      return {
        parentId,
        childId,
        promptFinished,
        events,
        dialogDepth: api.ui.dialog.depth,
        questions: questions.data,
        permissions: permissions.data,
        statuses: statuses.data,
        organization: organization.status === "loaded" ? organization.value : null,
        frame: {
          width: frame.width,
          height: frame.height,
          frameId: api.renderer.frameId,
          lines: frame.getSpanLines().map((line) =>
            line.spans.map((span) => ({
              text: span.text,
              width: span.width,
              fg: span.fg.toInts().slice(0, 3),
              bg: span.bg.toInts().slice(0, 3),
              attributes: span.attributes,
            })),
          ),
        },
      };
    }

    async function perform(request: Request): Promise<unknown> {
      switch (request.type) {
        case "seed": {
          assert(!parentId && !childId);
          const parent = await api.client.session.create({
            directory: scopeDirectory,
            title: "Synthetic attention parent",
          });
          assert(parent.data);
          parentId = parent.data.id;
          const child = await api.client.session.create({
            directory: scopeDirectory,
            parentID: parentId,
            title: "Synthetic attention child",
          });
          assert(child.data);
          childId = child.data.id;
          // Keep native question/permission input on its own session. This idle route
          // lets the sidebar expose off-route descendant attention while remaining usable.
          const current = await api.client.session.create({
            directory: scopeDirectory,
            title: "Synthetic current session",
          });
          assert(current.data);
          api.route.navigate("session", { sessionID: current.data.id });
          return { parentId, childId };
        }
        case "command":
          assert(request.command);
          return api.keymap.dispatchCommand(request.command);
        case "start":
          assert(childId);
          void api.client.session
            .prompt(
              {
                directory: scopeDirectory,
                sessionID: childId,
                model: { providerID: "synthetic", modelID: "synthetic" },
                parts: [{ type: "text", text: "Run the synthetic attention fixture." }],
              },
              { throwOnError: true, signal: api.lifecycle.signal },
            )
            .then(
              () => {
                promptFinished = true;
              },
              (error: unknown) => {
                promptError = error;
              },
            );
          return { started: true };
        case "reply-question": {
          const questions = await api.client.question.list({ directory: scopeDirectory });
          assert.equal(questions.data?.length, 1);
          const question = questions.data[0];
          assert(question && question.sessionID === childId);
          await api.client.question.reply(
            { directory: scopeDirectory, requestID: question.id, answers: [["Continue"]] },
            { throwOnError: true },
          );
          return { replied: true };
        }
        case "reply-permission": {
          const permissions = await api.client.permission.list({ directory: scopeDirectory });
          assert.equal(permissions.data?.length, 1);
          const permission = permissions.data[0];
          assert(permission && permission.sessionID === childId);
          assert.equal(permission.permission, "bash");
          await api.client.permission.reply(
            { directory: scopeDirectory, requestID: permission.id, reply: "once" },
            { throwOnError: true },
          );
          return { replied: true };
        }
        case "snapshot":
          return snapshot();
      }
    }

    async function tick() {
      if (running || closed) return;
      running = true;
      try {
        const raw = await readFile(`${exchange}.request.json`, "utf8").catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw error;
        });
        if (!raw || closed) return;
        const request = JSON.parse(raw) as Request;
        if (!Number.isSafeInteger(request.id) || request.id <= lastRequest) return;
        lastRequest = request.id;
        let response: object;
        try {
          response = { id: request.id, ok: true, result: await perform(request) };
        } catch (error) {
          response = { id: request.id, ok: false, error: String(error) };
        }
        if (closed) return;
        await writeFile(`${exchange}.response.tmp`, JSON.stringify(response));
        await rename(`${exchange}.response.tmp`, `${exchange}.response.json`);
      } finally {
        running = false;
      }
    }
    const interval = setInterval(() => void tick(), 10);
    api.lifecycle.onDispose(() => {
      closed = true;
      clearInterval(interval);
      for (const unsubscribe of off) unsubscribe();
    });
    await writeFile(`${exchange}.ready.json`, JSON.stringify({ version: api.app.version }));
  },
} satisfies TuiPluginModule;
