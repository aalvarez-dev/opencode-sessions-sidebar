/** Additional long-window observation: never replaces the original paired resource gates. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repository = resolve(import.meta.dir, "..");
const output = resolve(process.env.SIDEBAR_SUSTAINED_DIR ?? ".sidebar-lab/sustained");
const product = resolve(repository, "dist/tui.js");
const digest = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
await mkdir(output, { recursive: true });
const summary: Record<string, unknown> = {
  completed: false,
  acceptanceEvaluated: false,
  protocol: {
    sessions: 250,
    pairs: 1,
    order: ["baseline", "sidebar"],
    settleMs: 20_000,
    observationMs: 210_000,
    requiredHealthyCallsInWindow: 3,
    referenceBudgets: { rssMiB: 64, cpuPoints: 1 },
    retries: 0,
  },
  runtimeSha256: digest(await readFile(product)),
  limitations: [
    "Single long-window pair with parent thread sampling; not repeatability or original acceptance.",
    "Health wrapper forwards the original SDK method and records bounded timings in memory.",
    "No telemetry writes until after measurement. No fake health, forced GC or session cap.",
    "A passing long window cannot supersede a failed original short/delayed campaign.",
  ],
};
const wrapper = resolve(output, "health-wrapper.mjs");
const telemetry = resolve(output, "health.jsonl");
const report = resolve(output, "resources.json");
await writeFile(telemetry, "", { flag: "wx" });
const source = `import product from ${JSON.stringify(pathToFileURL(product).href)};
import { appendFileSync, existsSync } from "node:fs";
let activation = 0;
export default { ...product, async tui(api, options) {
  const number = ++activation, calls = [];
  let dropped = 0;
  async function health(...args) {
    const start = performance.now();
    const startedEpochMs = performance.timeOrigin + start;
    let healthy = false;
    try {
      const current = api.client.global;
      const result = await Reflect.apply(current.health, current, args);
      healthy = result.data?.healthy === true && !args[0]?.signal?.aborted;
      return result;
    } finally {
      if (calls.length < 32) calls.push({ startedEpochMs, durationMs: performance.now() - start, healthy });
      else dropped++;
    }
  }
  const forward = (read, overrides) => new Proxy(Object.create(null), {
    get(_target, key) {
      if (Object.hasOwn(overrides, key)) return overrides[key];
      const current = read(), value = Reflect.get(current, key, current);
      return typeof value === "function" ? value.bind(current) : value;
    },
    has(_target, key) { return key in read(); },
  });
  const global = forward(() => api.client.global, { health });
  const client = forward(() => api.client, { global });
  const wrapped = forward(() => api, { client });
  api.lifecycle.onDispose(() => {
    if (number !== 1) return;
    const outsideMeasurement = existsSync(process.env.SIDEBAR_RESOURCE_OUTPUT + ".lifecycle-started");
    appendFileSync(${JSON.stringify(telemetry)}, JSON.stringify({ activation: number, outsideMeasurement, calls, dropped }) + "\\n");
  });
  return Reflect.apply(product.tui, product, [wrapped, options]);
}};
`;
await writeFile(wrapper, source);
summary.wrapperSha256 = digest(source);
const destination = resolve(output, "summary.json");
await writeFile(destination, JSON.stringify(summary, null, 2));
try {
  const child = Bun.spawn([process.execPath, "scripts/benchmark-sidebar-runtime.ts"], {
    cwd: repository,
    env: {
      ...process.env,
      SIDEBAR_PLUGIN_FILE: wrapper,
      SIDEBAR_RESOURCE_SUSTAINED: "true",
      SIDEBAR_RESOURCE_DIAGNOSTIC: "false",
      SIDEBAR_RESOURCE_DELAYED: "false",
      SIDEBAR_RESOURCE_REPORT: report,
    },
    stdout: Bun.file(resolve(output, "runtime.log")),
    stderr: Bun.file(resolve(output, "runtime-errors.log")),
  });
  assert.equal(await child.exited, 0, "Sustained native observation failed.");
  const result = JSON.parse(await readFile(report, "utf8"));
  assert(result.completed && !result.acceptanceEvaluated);
  assert.equal(result.measurements.length, 2);
  assert(result.measurements.every((m: any) => m.probe.passed));
  const enabled = result.measurements.find((m: any) => m.enabled);
  const receipt = JSON.parse((await readFile(telemetry, "utf8")).trim());
  assert(receipt.outsideMeasurement && receipt.dropped === 0);
  const calls = receipt.calls.filter(
    (call: any) =>
      call.startedEpochMs >= enabled.observationStartedEpochMs &&
      call.startedEpochMs + call.durationMs <=
        enabled.observationStartedEpochMs + enabled.observationMs,
  );
  assert(calls.length >= 3, "Long window did not cover three completed health requests.");
  assert(calls.every((call: any) => call.healthy && call.durationMs < 2_000));
  for (let i = 1; i < calls.length; i++)
    assert(
      calls[i].startedEpochMs - calls[i - 1].startedEpochMs >= 60_000,
      "Health ran too often.",
    );
  assert.equal(digest(await readFile(product)), summary.runtimeSha256);
  summary.health = receipt;
  summary.healthCallsInWindow = calls.length;
  summary.results = result.results;
  const delta = result.results[0];
  summary.referenceBudgetsMet = delta.medianRssDeltaMiB <= 64 && delta.medianCpuDeltaPoints <= 1;
  summary.completed = true;
  assert(summary.referenceBudgetsMet, "Sustained observation exceeded original reference budgets.");
} catch (error) {
  summary.failure = String(error);
  throw error;
} finally {
  await writeFile(destination, JSON.stringify(summary, null, 2));
}
console.log(JSON.stringify(summary));
