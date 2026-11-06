/** Diagnostic only: compare the public health transport with an otherwise identical stub. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type Variant = "real" | "stub";
interface Trace {
  elapsedMs: number;
  intervalMs: number;
  cpuPercent: number | null;
}
interface Measurement {
  enabled: boolean;
  sessions: number;
  rssEndMiB: number;
  trace: Trace[];
  lifecycleStatus: string;
  probe: {
    passed: boolean;
    measurementAcknowledged: boolean;
    initialFrame: {
      hostSessionVisible: boolean;
      renderables: number;
      textBufferRenderables: number;
      mountedSessionRows: number;
      sessionRowShells: number;
    };
    finalFrame: {
      renderables: number;
      textBufferRenderables: number;
      mountedSessionRows: number;
      sessionRowShells: number;
    };
  };
}
interface HealthReceipt {
  variant: Variant;
  activation: number;
  outsideMeasurement: boolean;
  calls: number;
  successes: number;
  failures: number;
  droppedTimings: number;
  timings: { startedMs: number; durationMs: number; healthy: boolean; aborted: boolean }[];
}
interface Result {
  round: number;
  variant: Variant;
  valid: boolean;
  productSha256: string;
  wrapperSha256: string;
  report: string;
  telemetry: string;
  failure?: string;
  rssDeltaMiB?: number;
  lastTenSecondsCpuDeltaPoints?: number;
  health?: HealthReceipt;
}

const repository = resolve(import.meta.dir, "../..");
const output = resolve(process.env.SIDEBAR_HEALTH_DIAGNOSTIC_DIR ?? ".sidebar-lab/health-memory");
const product = resolve(repository, "dist/tui.js");
const digest = (contents: string | Buffer) => createHash("sha256").update(contents).digest("hex");
const productSha256 = digest(await readFile(product));
const prepareOnly = process.argv.includes("--prepare-only");
const results: Result[] = [];
const order: Variant[][] = [
  ["real", "stub"],
  ["stub", "real"],
  ["real", "stub"],
];
const limitations = [
  "Diagnostic only, not an acceptance gate or a product fix; the 64 MiB and 1 point budgets remain unchanged.",
  "Each variant has a separate stock baseline process; paired deltas do not eliminate process/allocator variation.",
  "The stub bypasses only the health SDK/RPC request. It retains the product monitor, timers and UI, but cannot validate transport loss.",
  "Timing uses a bounded in-memory array in both variants. Receipts are written only during post-measurement lifecycle disposal.",
  "The last ten seconds are a fixed trace window, not proof of steady state. RSS does not identify native buffers, worker heaps, JIT or allocator retention.",
];

function wrapper(variant: Variant, telemetry: string) {
  return `import product from ${JSON.stringify(pathToFileURL(product).href)};
import { appendFileSync, existsSync } from "node:fs";
const variant = ${JSON.stringify(variant)};
const telemetry = ${JSON.stringify(telemetry)};
let activation = 0;
export default {
  ...product,
  async tui(api, options) {
    const number = ++activation;
    const origin = performance.now();
    const timings = [];
    let calls = 0, successes = 0, failures = 0, droppedTimings = 0;
    async function health(...args) {
      calls++;
      const started = performance.now();
      let healthy = false;
      try {
        const current = api.client.global;
        args[0]?.signal?.throwIfAborted();
        const response = variant === "real"
          ? await Reflect.apply(current.health, current, args)
          : { data: { healthy: true, version: api.app.version } };
        healthy = response.data?.healthy === true && !args[0]?.signal?.aborted;
        if (healthy) successes++;
        else failures++;
        return response;
      } catch (error) {
        failures++;
        throw error;
      } finally {
        if (timings.length < 32) timings.push({ startedMs: started - origin, durationMs: performance.now() - started, healthy, aborted: args[0]?.signal?.aborted === true });
        else droppedTimings++;
      }
    }
    // Empty proxy targets avoid invariants of frozen/non-configurable host properties.
    // Each read forwards to the current host object with its original receiver.
    const forward = (read, override) => new Proxy(Object.create(null), {
      get(_target, key) {
        if (override && key === override.key) return override.value;
        const source = read();
        const value = Reflect.get(source, key, source);
        return typeof value === "function" ? value.bind(source) : value;
      },
      has(_target, key) { return key in read(); },
    });
    const global = forward(() => api.client.global, { key: "health", value: health });
    const client = forward(() => api.client, { key: "global", value: global });
    const wrapped = forward(() => api, { key: "client", value: client });
    api.lifecycle.onDispose(() => {
      const resource = process.env.SIDEBAR_RESOURCE_OUTPUT;
      if (!resource || !existsSync(resource + ".lifecycle-started")) return;
      appendFileSync(telemetry, JSON.stringify({ variant, activation: number, outsideMeasurement: true, calls, successes, failures, droppedTimings, timings }) + "\\n");
    });
    return Reflect.apply(product.tui, product, [wrapped, options]);
  },
};
`;
}

function lastTenSeconds(trace: Trace[]) {
  assert(trace.length >= 30, "Missing diagnostic time series.");
  const end = trace.at(-1)!.elapsedMs;
  const start = end - 10_000;
  let weighted = 0;
  let covered = 0;
  for (const point of trace) {
    if (point.cpuPercent === null) continue;
    const duration = Math.max(
      0,
      Math.min(end, point.elapsedMs) - Math.max(start, point.elapsedMs - point.intervalMs),
    );
    weighted += point.cpuPercent * duration;
    covered += duration;
  }
  assert(Math.abs(covered - 10_000) < 1, "Last-ten-second trace coverage is incomplete.");
  return weighted / covered;
}

function median(values: number[]) {
  assert.equal(values.length, 3);
  return [...values].sort((a, b) => a - b)[1]!;
}

async function save() {
  const completed = results.length === 6 && results.every((result) => result.valid);
  const summary = completed
    ? Object.fromEntries(
        (["real", "stub"] as const).map((variant) => {
          const selected = results.filter((result) => result.variant === variant);
          return [
            variant,
            {
              medianRssDeltaMiB: median(selected.map((result) => result.rssDeltaMiB!)),
              medianLastTenSecondsCpuDeltaPoints: median(
                selected.map((result) => result.lastTenSecondsCpuDeltaPoints!),
              ),
            },
          ];
        }),
      )
    : undefined;
  await writeFile(
    resolve(output, "summary.json"),
    JSON.stringify(
      {
        schema: 1,
        kind: "health-transport-isolation-diagnostic",
        acceptanceEvaluated: false,
        completed,
        productSha256,
        order,
        results,
        ...(summary ? { summary } : {}),
        limitations,
      },
      null,
      2,
    ) + "\n",
  );
}

assert.equal(Bun.version, "1.3.14");
assert.equal(process.platform, "linux");
assert(process.env.OPENCODE_BIN);
await mkdir(output, { recursive: true });
await save();
for (const [index, variants] of order.entries()) {
  for (const variant of variants) {
    const round = index + 1;
    const directory = resolve(output, `round-${round}-${variant}`);
    await mkdir(directory, { recursive: true });
    const plugin = resolve(directory, "wrapper.mjs");
    const telemetry = resolve(directory, "health.jsonl");
    const report = resolve(directory, "resources.json");
    const contents = wrapper(variant, telemetry);
    await writeFile(plugin, contents);
    await writeFile(telemetry, "");
    const result: Result = {
      round,
      variant,
      valid: false,
      productSha256,
      wrapperSha256: digest(contents),
      report,
      telemetry,
    };
    results.push(result);
    await save();
    if (prepareOnly) continue;
    try {
      assert.equal(
        digest(await readFile(product)),
        productSha256,
        "Product changed during diagnostic.",
      );
      const child = Bun.spawn([process.execPath, "scripts/benchmark-sidebar-runtime.ts"], {
        cwd: repository,
        env: {
          ...process.env,
          SIDEBAR_PLUGIN_FILE: plugin,
          SIDEBAR_RESOURCE_DIAGNOSTIC: "true",
          SIDEBAR_RESOURCE_DELAYED: "false",
          SIDEBAR_RESOURCE_REPORT: report,
        },
        stdout: Bun.file(resolve(directory, "stdout.log")),
        stderr: Bun.file(resolve(directory, "stderr.log")),
      });
      assert.equal(
        await child.exited,
        0,
        "Diagnostic subprocess failed; inspect retained logs/report.",
      );
      const raw = JSON.parse(await readFile(report, "utf8"));
      assert.equal(raw.kind, "diagnostic-time-series");
      assert.equal(raw.acceptanceEvaluated, false);
      assert.equal(raw.completed, true);
      assert.equal(raw.source.sha256.runtimePlugin, result.wrapperSha256);
      assert.equal(raw.environment.observationMs, 30_000);
      assert.equal(raw.environment.settleMs, 2_000);
      const measurements = raw.measurements as Measurement[];
      assert.equal(measurements.length, 2);
      const baseline = measurements.find((measurement) => !measurement.enabled);
      const enabled = measurements.find((measurement) => measurement.enabled);
      assert(baseline && enabled);
      for (const measurement of measurements) {
        assert.equal(measurement.sessions, 250);
        assert.equal(measurement.lifecycleStatus, "passed");
        assert(measurement.probe.passed && measurement.probe.measurementAcknowledged);
        assert(measurement.probe.initialFrame.hostSessionVisible);
        for (const key of [
          "renderables",
          "textBufferRenderables",
          "mountedSessionRows",
          "sessionRowShells",
        ] as const)
          assert.equal(
            measurement.probe.finalFrame[key],
            measurement.probe.initialFrame[key],
            "Rendered tree changed during the diagnostic window.",
          );
        assert.equal(measurement.probe.finalFrame.sessionRowShells, measurement.enabled ? 250 : 0);
        assert.equal(measurement.probe.finalFrame.mountedSessionRows, measurement.enabled ? 5 : 0);
      }
      const receipts = (await readFile(telemetry, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as HealthReceipt);
      const health = receipts.find((receipt) => receipt.activation === 1);
      assert(health && health.outsideMeasurement && health.variant === variant);
      assert(
        health.calls > 0 && health.successes === health.calls && health.failures === 0,
        "No successful health activity observed, or health request failed.",
      );
      assert.equal(health.droppedTimings, 0);
      assert.equal(health.timings.length, health.calls);
      assert(
        health.timings.every(
          (timing) =>
            timing.healthy &&
            !timing.aborted &&
            Number.isFinite(timing.durationMs) &&
            timing.durationMs >= 0,
        ),
      );
      assert.equal(digest(await readFile(product)), productSha256);
      result.health = health;
      result.rssDeltaMiB = enabled.rssEndMiB - baseline.rssEndMiB;
      result.lastTenSecondsCpuDeltaPoints =
        lastTenSeconds(enabled.trace) - lastTenSeconds(baseline.trace);
      result.valid = true;
    } catch (error) {
      result.failure = error instanceof Error ? error.message : String(error);
    }
    await save();
    console.log(JSON.stringify({ round, variant, valid: result.valid, failure: result.failure }));
  }
}
if (!prepareOnly)
  assert(
    results.length === 6 && results.every((result) => result.valid),
    "Health isolation diagnostic incomplete; inspect retained artifacts.",
  );
