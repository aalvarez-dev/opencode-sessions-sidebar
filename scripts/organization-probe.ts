/** Temporary stock-TUI test plugin; this is not the released sidebar entrypoint. */
import assert from "node:assert/strict";
import { rename, writeFile } from "node:fs/promises";
import type { TuiPluginModule } from "@opencode-ai/plugin/tui";
import { createOrganizationService } from "../src/organization/service.js";
import { organizationSessionKey } from "../src/organization/schema.js";
import type {
  OrganizationDocument,
  OrganizationEvent,
  OrganizationScope,
} from "../src/organization/types.js";
import { createFileStorage } from "../src/storage/file.js";

interface Expected {
  readonly scope: OrganizationScope;
  readonly sessionIds: readonly [string, string];
  readonly document: OrganizationDocument;
  readonly staleRevision: number;
}

async function result(output: string, value: object) {
  await writeFile(`${output}.tmp`, JSON.stringify(value));
  await rename(`${output}.tmp`, output);
}

export default {
  id: "synthetic-sidebar-organization-probe",
  async tui(api) {
    const output = process.env.SIDEBAR_ORGANIZATION_OUTPUT;
    const directory = process.env.SIDEBAR_ORGANIZATION_DIRECTORY;
    const storageDirectory = process.env.SIDEBAR_ORGANIZATION_STORAGE;
    const expectedPath = process.env.SIDEBAR_ORGANIZATION_EXPECTED;
    const phase = process.env.SIDEBAR_ORGANIZATION_PHASE;
    assert(
      output &&
        directory &&
        storageDirectory &&
        expectedPath &&
        (phase === "write" || phase === "read"),
      "Probe requires an isolated organization-smoke environment.",
    );
    let service: ReturnType<typeof createOrganizationService> | undefined;
    let unsubscribe: (() => void) | undefined;
    try {
      assert.equal(api.app.version, "1.18.30");
      const project = await api.client.project.current({ directory });
      assert(project.data);
      const scope = {
        // This stable identity is explicitly supplied by the test caller. The
        // temporary server URL or a local directory is not treated as host identity.
        hostId: "synthetic-organization-runtime",
        projectId: project.data.id,
      };
      service = createOrganizationService({
        scope,
        storage: createFileStorage({ directory: storageDirectory }),
      });
      const events: OrganizationEvent[] = [];
      unsubscribe = service.subscribe("synthetic-probe-listener", (event) => {
        events.push(event);
      });
      await service.start();
      assert.equal(service.snapshot().phase, "ready");
      assert.equal(events.length, 0, "Hydration must not replay committed actions.");

      if (phase === "write") {
        const first = await api.client.session.create({
          directory,
          title: "Synthetic organization first",
        });
        const second = await api.client.session.create({
          directory,
          title: "Synthetic organization second",
        });
        assert(first.data && second.data);
        const firstId = first.data.id;
        const secondId = second.data.id;
        const firstKey = organizationSessionKey(scope, firstId);
        const secondKey = organizationSessionKey(scope, secondId);
        let commandNumber = 0;
        function context() {
          const document = service?.snapshot().document;
          assert(document);
          return {
            commandId: `synthetic-command-${++commandNumber}`,
            expectedRevision: document.revision,
            origin: { type: "user" as const },
          };
        }
        assert.equal(
          (
            await service.dispatch({
              ...context(),
              type: "set-pin",
              sessionId: firstId,
              pinned: true,
            })
          ).status,
          "committed",
        );
        const staleRevision = service.snapshot().document?.revision;
        assert(typeof staleRevision === "number");
        assert.equal(
          (
            await service.dispatch({
              ...context(),
              type: "set-completion",
              sessionId: firstId,
              done: true,
            })
          ).status,
          "committed",
        );
        assert.equal(
          (await service.dispatch({ ...context(), type: "add-later", sessionId: firstId })).status,
          "committed",
        );
        assert.equal(
          (await service.dispatch({ ...context(), type: "add-later", sessionId: secondId })).status,
          "committed",
        );
        assert.equal(
          (
            await service.dispatch({
              ...context(),
              type: "reorder-later",
              sessionIds: [secondId, firstId],
            })
          ).status,
          "committed",
        );
        const document = service.snapshot().document;
        assert(document);
        assert.deepEqual(document.pins, [firstKey]);
        assert.deepEqual(document.later, [secondKey, firstKey]);
        assert.deepEqual(
          document.completionStates.map((state) => [state.sessionKey, state.done]),
          [[firstKey, true]],
        );
        assert(document.revision > staleRevision);
        // Observers are dispatched asynchronously after storage acknowledgement.
        for (let attempt = 0; events.length < 5 && attempt < 100; attempt++) await Bun.sleep(10);
        assert.equal(events.length, 5);
        assert.equal(new Set(events.map((event) => event.id)).size, 5);
        assert(events.every((event) => event.id !== event.causationId));
        assert.deepEqual(
          events.map((event) => event.type),
          [
            "session.pin.changed",
            "session.completion.changed",
            "queue.added",
            "queue.added",
            "queue.reordered",
          ],
        );
        await result(output, {
          passed: true,
          version: api.app.version,
          phase,
          replayEvents: 0,
          expected: {
            scope,
            sessionIds: [firstId, secondId],
            document,
            staleRevision,
          } satisfies Expected,
        });
      } else {
        const stored: { expected: Expected } = await Bun.file(expectedPath).json();
        const expected = stored.expected;
        assert.deepEqual(scope, expected.scope);
        // Native sessions survive independently in OpenCode's public session API.
        const sessions = await api.client.session.list({ directory });
        assert(sessions.data);
        for (const sessionId of expected.sessionIds) {
          assert(sessions.data.some((session) => session.id === sessionId));
        }
        assert.deepEqual(service.snapshot().document, expected.document);
        await service.refresh();
        assert.deepEqual(service.snapshot().document, expected.document);
        const stale = await service.dispatch({
          type: "set-pin",
          sessionId: expected.sessionIds[0],
          pinned: false,
          expectedRevision: expected.staleRevision,
          commandId: "synthetic-delayed-before-restart",
          origin: { type: "extension", id: "synthetic-delayed-extension" },
        });
        assert.equal(stale.status, "stale");
        assert.deepEqual(service.snapshot().document, expected.document);
        await Bun.sleep(50);
        assert.equal(
          events.length,
          0,
          "Restart, refresh and rejected stale actions must emit no events.",
        );
        await result(output, {
          passed: true,
          version: api.app.version,
          phase,
          replayEvents: events.length,
        });
      }
    } catch (error) {
      await result(output, {
        passed: false,
        message: error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
    } finally {
      unsubscribe?.();
      service?.dispose();
    }
  },
} satisfies TuiPluginModule;
