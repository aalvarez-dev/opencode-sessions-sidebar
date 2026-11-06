/** Shared stock-TUI observer. No polling, reads, or lifecycle work during measured idle. */
import assert from "node:assert/strict";
import { watch, type FSWatcher } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import type { TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import type { Renderable } from "@opentui/core";

export interface ResourceProbeResult {
  passed: boolean;
  message?: string;
  initialFrame?: {
    sidebarVisible: boolean;
    selectedSession: boolean;
    width: number;
    height: number;
  };
  lifecycle?: { deactivated: boolean; reactivated: boolean; activationMs: number }[];
  measurementAcknowledged?: boolean;
}

async function publish(path: string, value: object) {
  await writeFile(`${path}.tmp`, JSON.stringify(value));
  await rename(`${path}.tmp`, path);
}

async function waitForMeasurement(
  output: string,
  signal: AbortSignal,
  ready: object,
): Promise<void> {
  const completionPath = `${output}.measurement-finished`;
  // Bun 1.3.14 can drop the destination event of an atomic rename on Linux
  // (oven-sh/bun#36328). Keep this inode and signal with one append after sampling.
  await writeFile(completionPath, "", { flag: "wx" });
  return new Promise((resolve, reject) => {
    let watcher: FSWatcher | undefined;
    let settled = false;
    const timeout = setTimeout(
      () => finish(new Error("Parent did not finish the bounded resource measurement.")),
      90_000,
    );
    function finish(error?: unknown) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      watcher?.close();
      signal.removeEventListener("abort", aborted);
      if (error) reject(error);
      else resolve();
    }
    function aborted() {
      finish(signal.reason ?? new Error("Resource observer disposed before measurement finished."));
    }
    try {
      // Watch this precreated file, not a rename destination or an entire directory.
      // No periodic polling, SDK calls, or renderer inspection occurs during sampling.
      watcher = watch(completionPath, { persistent: false }, () => {
        void readFile(completionPath, "utf8").then((value) => {
          if (value === "measurement-complete\n") finish();
          else finish(new Error("Invalid measurement completion receipt."));
        }, finish);
      });
      watcher.on("error", finish);
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) aborted();
      else void publish(`${output}.ready`, ready).catch(finish);
    } catch (error) {
      finish(error);
    }
  });
}

async function measure(api: TuiPluginApi) {
  const output = process.env.SIDEBAR_RESOURCE_OUTPUT;
  const directory = process.env.SIDEBAR_RESOURCE_DIRECTORY;
  const sessionId = process.env.SIDEBAR_RESOURCE_SESSION;
  const enabled = process.env.SIDEBAR_RESOURCE_ENABLED === "true";
  const expected = Number(process.env.SIDEBAR_RESOURCE_SESSIONS);
  assert(output && directory && sessionId);
  const id = "opencode-sessions-sidebar";
  const marker = `sidebar-session-${sessionId}-completion`;
  const lifecycle: NonNullable<ResourceProbeResult["lifecycle"]> = [];

  function visible(node: Renderable): boolean {
    let left = Math.max(0, node.screenX);
    let top = Math.max(0, node.screenY);
    let right = Math.min(api.renderer.terminalWidth, node.screenX + node.width);
    let bottom = Math.min(api.renderer.terminalHeight, node.screenY + node.height);
    for (let ancestor: Renderable | null = node; ancestor; ancestor = ancestor.parent) {
      if (!ancestor.visible || ancestor.isDestroyed || ancestor.opacity <= 0) return false;
      if (ancestor.overflow !== "visible") {
        left = Math.max(left, ancestor.screenX);
        top = Math.max(top, ancestor.screenY);
        right = Math.min(right, ancestor.screenX + ancestor.width);
        bottom = Math.min(bottom, ancestor.screenY + ancestor.height);
      }
      if (right <= left || bottom <= top) return false;
      if (ancestor === api.renderer.root) return true;
    }
    return false;
  }

  function sidebarVisible(): boolean {
    const pending: Renderable[] = [api.renderer.root];
    let examined = 0;
    while (pending.length && examined++ < 20_000) {
      const node = pending.pop()!;
      if (node.id === marker && visible(node)) {
        const text = api.renderer.currentRenderBuffer
          .getSpanLines()
          .map((line) => line.spans.map((span) => span.text).join(""))
          .join("\n");
        return text.includes("Active session:") && text.includes("Mark completed");
      }
      pending.push(...node.getChildren());
    }
    return false;
  }

  async function until(check: () => boolean, message: string) {
    const start = performance.now();
    while (!check()) {
      api.lifecycle.signal.throwIfAborted();
      assert(performance.now() - start < 20_000, message);
      await Bun.sleep(25);
    }
  }

  function selected() {
    const route = api.route.current;
    return route.name === "session" && route.params?.sessionID === sessionId;
  }

  try {
    assert.equal(api.app.version, "1.18.30");
    const sessions = await api.client.session.list(
      { directory, limit: expected },
      { throwOnError: true },
    );
    assert.equal(sessions.data?.length, expected);
    assert(sessions.data?.some((session) => session.id === sessionId));
    api.route.navigate("session", { sessionID: sessionId });
    await until(
      () => api.state.ready && selected(),
      "Synthetic session route did not become ready.",
    );
    if (enabled) await until(sidebarVisible, "Enabled sidebar did not render in the viewport.");
    else assert(!api.plugins.list().some((plugin) => plugin.id === id));
    const initialFrame = {
      sidebarVisible: sidebarVisible(),
      selectedSession: selected(),
      width: api.renderer.terminalWidth,
      height: api.renderer.terminalHeight,
    };
    assert.equal(initialFrame.sidebarVisible, enabled);
    assert.equal(initialFrame.width, 140);
    assert.equal(initialFrame.height, 40);
    const proc = await readFile("/proc/self/status", "utf8");
    const procPid = Number(proc.match(/^Pid:\s+(\d+)/m)?.[1]);
    assert(Number.isSafeInteger(procPid) && procPid > 0);
    await waitForMeasurement(output, api.lifecycle.signal, {
      pid: process.pid,
      procPid,
      initialFrame,
      measurementProtocol: "append-receipt-v2",
    });
    await publish(`${output}.lifecycle-started`, { measurementAcknowledged: true });
    assert.equal(sidebarVisible(), enabled, "Sidebar visibility changed during idle.");
    if (enabled) {
      for (let cycle = 0; cycle < 2; cycle++) {
        const deactivated = await api.plugins.deactivate(id);
        assert(deactivated);
        await until(() => !sidebarVisible(), "Deactivation retained the sidebar.");
        const started = performance.now();
        const reactivated = await api.plugins.activate(id);
        assert(reactivated);
        await until(sidebarVisible, "Reactivation failed to render the sidebar.");
        lifecycle.push({ deactivated, reactivated, activationMs: performance.now() - started });
      }
      assert(await api.plugins.deactivate(id));
      await until(() => !sidebarVisible(), "Final deactivation retained sidebar controls.");
    }
    await publish(output, {
      passed: true,
      initialFrame,
      lifecycle,
      measurementAcknowledged: true,
    } satisfies ResourceProbeResult);
  } catch (error) {
    await publish(output, { passed: false, message: String(error), lifecycle });
  }
}

export default {
  id: "synthetic-sidebar-resource-observer",
  async tui(api) {
    void measure(api);
  },
} satisfies TuiPluginModule;
