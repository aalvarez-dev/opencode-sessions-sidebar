/** Test-only local observer: snapshots never contact the disconnected server. */
import assert from "node:assert/strict";
import { validationHostVersion } from "./lib/validation-host";
import { readFile, rename, writeFile } from "node:fs/promises";
import type { TuiPluginModule } from "@opencode-ai/plugin/tui";
import type { Renderable } from "@opentui/core";
import { createFileStorage } from "../src/storage/file.js";

export default {
  id: "synthetic-sidebar-remote-observer",
  async tui(api) {
    const exchange = process.env.SIDEBAR_REMOTE_EXCHANGE;
    const storageDirectory = process.env.SIDEBAR_REMOTE_STORAGE;
    const projectId = process.env.SIDEBAR_REMOTE_PROJECT;
    const sessionIds = JSON.parse(process.env.SIDEBAR_REMOTE_SESSIONS ?? "[]") as string[];
    assert(exchange && storageDirectory && projectId && sessionIds.length);
    assert.equal(api.app.version, validationHostVersion);
    const storage = createFileStorage({ directory: storageDirectory });
    const scope = { hostId: "synthetic-sidebar-remote", projectId };
    const events: { type: string; elapsedMs: number }[] = [];
    const started = performance.now();
    const disposeEvents = ["server.connected", "server.instance.disposed"] as const;
    const subscriptions = disposeEvents.map((type) =>
      api.event.on(type, () => {
        events.push({ type, elapsedMs: performance.now() - started });
      }),
    );
    let closed = false;
    let running = false;
    let lastRequest = 0;

    async function snapshot() {
      // Only plugin-owned local storage and public, already-held host state.
      // In particular, no api.client.* request and no adapter invalidation.
      const document = await storage.read(scope);
      const geometry = [];
      const pending: Renderable[] = [api.renderer.root];
      while (pending.length && geometry.length < 3000) {
        const node = pending.pop()!;
        geometry.push({
          id: node.id,
          x: node.screenX,
          y: node.screenY,
          width: node.width,
          height: node.height,
          visible: node.visible,
          ...("plainText" in node && typeof node.plainText === "string"
            ? { text: node.plainText.slice(0, 300) }
            : {}),
        });
        pending.push(...node.getChildren());
      }
      const frame = api.renderer.currentRenderBuffer;
      return {
        elapsedMs: performance.now() - started,
        events,
        route: api.route.current,
        dialogDepth: api.ui.dialog.depth,
        path: api.state.path,
        plugins: api.plugins.list().map(({ id, active }) => ({ id, active })),
        hostSessions: sessionIds.map((id) => ({
          id,
          title: api.state.session.get(id)?.title,
          status: api.state.session.status(id),
        })),
        organization: document.status === "loaded" ? document.value : null,
        geometry,
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

    async function tick() {
      if (closed || running) return;
      running = true;
      try {
        const raw = await readFile(`${exchange}.request.json`, "utf8").catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw error;
        });
        if (!raw || closed) return;
        const request = JSON.parse(raw) as { id: number; type: string; command?: string };
        if (!Number.isSafeInteger(request.id) || request.id <= lastRequest) return;
        lastRequest = request.id;
        let response: object;
        try {
          let result: unknown;
          if (request.type === "snapshot") result = await snapshot();
          else if (request.type === "command" && request.command)
            result = api.keymap.dispatchCommand(request.command);
          else throw new Error("Unknown remote probe request.");
          response = { id: request.id, ok: true, result };
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
      for (const dispose of subscriptions) dispose();
    });
    await writeFile(`${exchange}.ready.json`, JSON.stringify({ version: api.app.version }));
  },
} satisfies TuiPluginModule;
