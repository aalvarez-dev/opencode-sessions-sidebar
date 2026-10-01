/** Test-only observer for the actual sidebar loaded by stock OpenCode. */
import assert from "node:assert/strict";
import { readFile, rename, writeFile } from "node:fs/promises";
import type { TuiPluginModule } from "@opencode-ai/plugin/tui";
import type { Renderable } from "@opentui/core";
import { createFileStorage } from "../src/storage/file.js";

interface Request {
  readonly id: number;
  readonly type: "snapshot" | "seed" | "command" | "deactivate" | "activate" | "burst";
  readonly command?: string;
}

export default {
  id: "synthetic-sidebar-ui-observer",
  async tui(api) {
    const exchange = process.env.SIDEBAR_SMOKE_EXCHANGE;
    const directory = process.env.SIDEBAR_SMOKE_DIRECTORY;
    const storageDirectory = process.env.SIDEBAR_SMOKE_STORAGE;
    assert(
      exchange && directory && storageDirectory,
      "Missing isolated sidebar probe environment.",
    );
    assert.equal(api.app.version, "1.18.30");
    const scopeDirectory = directory;
    const storage = createFileStorage({ directory: storageDirectory });
    let lastRequest = 0;
    let running = false;
    let closed = false;
    const initialIds: string[] = [];
    let burst: {
      running: boolean;
      count: number;
      hostOperationsMs: number;
      error?: string;
    } | null = null;
    const project = await api.client.project.current({ directory: scopeDirectory });
    assert(project.data);
    const scope = { hostId: "synthetic-sidebar-runtime", projectId: project.data.id };

    function geometry() {
      const result: {
        id: string;
        parent: string | null;
        type: string;
        x: number;
        y: number;
        width: number;
        height: number;
        visible: boolean;
        text?: string;
      }[] = [];
      const pending: Renderable[] = [api.renderer.root];
      while (pending.length && result.length < 2000) {
        const node = pending.pop()!;
        result.push({
          id: node.id,
          parent: node.parent?.id ?? null,
          type: node.constructor.name,
          x: node.screenX,
          y: node.screenY,
          width: node.width,
          height: node.height,
          visible: node.visible,
          ...("plainText" in node && typeof node.plainText === "string"
            ? { text: node.plainText.slice(0, 240) }
            : {}),
        });
        pending.push(...node.getChildren());
      }
      return result;
    }
    async function snapshot() {
      const started = performance.now();
      const sessions = await api.client.session.list({ directory: scopeDirectory });
      const listFinished = performance.now();
      assert(sessions.data);
      const document = await storage.read(scope);
      const storageFinished = performance.now();
      const frame = api.renderer.currentRenderBuffer;
      return {
        timing: {
          listMs: listFinished - started,
          storageMs: storageFinished - listFinished,
          observerMs: storageFinished - started,
        },
        version: api.app.version,
        theme: { mode: api.theme.mode(), selected: api.theme.selected },
        palette: Object.fromEntries(
          (["text", "textMuted", "success", "warning", "error"] as const).map((name) => [
            name,
            api.theme.current[name].toInts().slice(0, 3),
          ]),
        ),
        route: api.route.current,
        dialogDepth: api.ui.dialog.depth,
        plugins: api.plugins.list().map(({ id, active, enabled }) => ({ id, active, enabled })),
        sessions: sessions.data.map(({ id, title }) => ({ id, title })),
        organization: document.status === "loaded" ? document.value : null,
        initialIds,
        burst,
        ...(process.env.SIDEBAR_SMOKE_GEOMETRY === "true" ? { geometry: geometry() } : {}),
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
          assert.equal(initialIds.length, 0);
          // Synthetic public host records; no private database or model inference.
          for (const title of [
            "Synthetic Alpha",
            "Synthetic Beta",
            ...Array.from(
              { length: 18 },
              (_, index) =>
                `Synthetic ${String(index + 1).padStart(2, "0")} long session title for scrolling`,
            ),
          ]) {
            const response = await api.client.session.create({ directory: scopeDirectory, title });
            assert(response.data);
            initialIds.push(response.data.id);
          }
          api.route.navigate("session", { sessionID: initialIds[0] });
          return { count: initialIds.length };
        }
        case "command":
          assert(request.command);
          return api.keymap.dispatchCommand(request.command);
        case "deactivate":
          return { changed: await api.plugins.deactivate("opencode-sessions-sidebar") };
        case "activate":
          return { changed: await api.plugins.activate("opencode-sessions-sidebar") };
        case "burst": {
          assert(initialIds[1]);
          assert(!burst?.running, "A burst is already running.");
          const sessionID = initialIds[1];
          const state = { running: true, count: 0, hostOperationsMs: 0 } as NonNullable<
            typeof burst
          >;
          burst = state;
          const started = performance.now();
          // A controlled native event stream overlaps real keyboard navigation.
          // Its explicit 10ms spacing is fixture pacing, not host throughput.
          void (async () => {
            try {
              for (let index = 0; index < 20 && !closed; index++) {
                const response: { data: { id: string } | undefined } =
                  await api.client.session.update({
                    directory: scopeDirectory,
                    sessionID,
                    title: `Synthetic Beta burst ${String(index + 1).padStart(2, "0")}`,
                  });
                assert(response.data);
                state.count++;
                await Bun.sleep(10);
              }
            } catch (error) {
              state.error = String(error);
            } finally {
              state.hostOperationsMs = performance.now() - started;
              state.running = false;
            }
          })();
          return { started: true };
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
    });
    await writeFile(`${exchange}.ready.json`, JSON.stringify({ version: api.app.version }));
  },
} satisfies TuiPluginModule;
