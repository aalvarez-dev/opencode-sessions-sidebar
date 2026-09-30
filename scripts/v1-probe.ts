/** Temporary test plugin, bundled by smoke-v1.ts --tui. It is not the sidebar entrypoint. */
import assert from "node:assert/strict";
import { rename, writeFile } from "node:fs/promises";
import type { TuiPluginModule } from "@opencode-ai/plugin/tui";
import { createV1Adapter } from "../src/adapters/opencode-v1/index.js";

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await Bun.sleep(20);
  }
  throw new Error("TUI host did not deliver the expected update.");
}

async function result(output: string, value: object) {
  await writeFile(`${output}.tmp`, JSON.stringify(value));
  await rename(`${output}.tmp`, output);
}

export default {
  id: "synthetic-sidebar-runtime-probe",
  async tui(api) {
    const output = process.env.SIDEBAR_PROBE_OUTPUT;
    const directory = process.env.SIDEBAR_PROBE_DIRECTORY;
    assert(output && directory, "Probe requires an isolated smoke-test environment.");
    let adapter: ReturnType<typeof createV1Adapter> | undefined;
    try {
      assert.equal(api.app.version, "1.18.30");
      const project = await api.client.project.current({ directory });
      assert(project.data);
      const scope = {
        hostId: "synthetic-tui-runtime",
        projectId: project.data.id,
        directory,
      };
      adapter = createV1Adapter(api, scope);
      await adapter.start();
      assert.equal(adapter.state().phase, "ready");
      const created = await adapter.create("Synthetic TUI session");
      assert.equal(created.status, "succeeded");
      assert(created.sessionId);
      const id = created.sessionId;
      assert(adapter.get(id));
      assert.equal((await adapter.rename(id, "Synthetic renamed")).status, "succeeded");
      await until(() => adapter?.get(id)?.title === "Synthetic renamed");
      assert.equal(adapter.open(id).status, "requested");
      await until(() => {
        adapter?.observeRoute();
        return adapter?.state().selectedSessionId === id;
      });

      // Exercise the actual host event bus, independently of action-response snapshots.
      const native = await api.client.session.create({
        directory,
        title: "Synthetic native event",
      });
      assert(native.data);
      const nativeId = native.data.id;
      await until(() => Boolean(adapter?.get(nativeId)));
      await api.client.session.update({
        directory,
        sessionID: nativeId,
        title: "Synthetic native rename",
      });
      await until(() => adapter?.get(nativeId)?.title === "Synthetic native rename");
      await api.client.session.delete({ directory, sessionID: nativeId });
      await until(() => !adapter?.get(nativeId));

      // Recreate with the same real host object. The public TUI API does not offer
      // a directory-switch command, so this is a lifecycle proof within one scope.
      const previousAdapter = adapter;
      adapter.dispose();
      assert.equal(adapter.state().phase, "disposed");
      adapter = createV1Adapter(api, scope);
      await adapter.start();
      assert.equal(adapter.state().phase, "ready");
      assert.equal(adapter.get(id)?.title, "Synthetic renamed");
      await api.client.session.update({
        directory,
        sessionID: id,
        title: "Synthetic after recreation",
      });
      await until(() => adapter?.get(id)?.title === "Synthetic after recreation");
      assert.equal(previousAdapter.state().phase, "disposed");
      assert.equal(previousAdapter.list().length, 0);
      assert.equal(adapter.open(id).status, "requested");
      await until(() => {
        adapter?.observeRoute();
        return adapter?.state().selectedSessionId === id;
      });
      assert.equal((await adapter.delete(id)).status, "succeeded");
      adapter.dispose();
      assert.equal(adapter.state().phase, "disposed");
      await result(output, { passed: true, version: api.app.version });
    } catch (error) {
      await result(output, {
        passed: false,
        message: error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
    } finally {
      adapter?.dispose();
    }
  },
} satisfies TuiPluginModule;
