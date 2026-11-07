/** Isolated follow-up on an immutable candidate. Never edits product or acceptance scripts. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const candidateSha = "4f5f1ba3cd5ac4facef0e93cd9668f6aaf32d417";
const productSha256 = "a91d70019f34307548355234859f80130bac1cc8483adee6bdcc9535bf1a472d";
const mode = process.argv[2];
assert(mode === "long-idle" || mode === "cycles");
const smoke = process.argv.includes("--smoke");
assert(!smoke || process.env.GITHUB_ACTIONS !== "true", "Smoke is local preflight only.");
const prepareOnly = process.argv.includes("--prepare-only");
const repository = resolve(process.env.SIDEBAR_CANDIDATE_ROOT ?? "candidate");
const output = resolve(process.env.SIDEBAR_STABILITY_OUTPUT ?? `.sidebar-lab/stability/${mode}`);
const generated = join(output, "generated");
await mkdir(dirname(output), { recursive: true });
await mkdir(output); // Refuse to overwrite any earlier attempt.
await mkdir(generated);
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const git = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repository });
assert.equal(git.exitCode, 0);
assert.equal(git.stdout.toString().trim(), candidateSha);
const product = join(repository, "dist/tui.js");
assert.equal(digest(await readFile(product)), productSha256);
const duration = smoke ? 3_000 : 20 * 60_000;
const interval = smoke ? 1_000 : 60_000;
const cycles = smoke ? 2 : 50;
const protocol = {
  candidateSha,
  productSha256,
  mode,
  smoke,
  prepareOnly,
  acceptanceEvaluated: false,
  sessions: 250,
  settleMs: mode === "long-idle" ? 20_000 : 2_000,
  observationMs: mode === "long-idle" ? duration : 5_000,
  checkpointMs: mode === "long-idle" ? interval : null,
  cycles: mode === "cycles" ? cycles : 2,
  activeWaitMs: mode === "cycles" ? 5_500 : null,
  inactiveWaitMs: mode === "cycles" ? 7_500 : null,
  retries: 0,
  limitations: [
    "Long observation and lifecycle are separate from the three original acceptance campaigns.",
    "RSS and heap counters do not establish allocation ownership or zero retained memory.",
    "Cycle instrumentation counts public event subscriptions and SDK health calls only; no global timer census.",
    "A quiet inactive interval checks observable late requests, not every unreachable closure or pending task.",
    "No forced GC, profiler, heap snapshot, extra inference or user-machine access.",
  ],
};
await writeFile(join(output, "protocol.json"), JSON.stringify(protocol, null, 2));

/** Fail closed if a pinned source anchor changes or unexpectedly appears twice. */
function replaceOnce(source: string, before: string, after: string) {
  assert.equal(source.split(before).length, 2, `Expected exactly one source anchor: ${before}`);
  return source.replace(before, after);
}
let harness = await readFile(join(repository, "scripts/benchmark-sidebar-runtime.ts"), "utf8");
let observer = await readFile(join(repository, "scripts/sidebar-resource-probe.ts"), "utf8");
const originalHashes = { harness: digest(harness), observer: digest(observer) };
let trackerSha256: string | null = null;
harness = replaceOnce(
  harness,
  'const repository = resolve(import.meta.dir, "..");',
  `const repository = ${JSON.stringify(repository)};`,
);
harness = replaceOnce(
  harness,
  'const diagnostic = process.env.SIDEBAR_RESOURCE_DIAGNOSTIC === "true";',
  "const diagnostic = false;",
);
harness = replaceOnce(
  harness,
  'const delayed = process.env.SIDEBAR_RESOURCE_DELAYED === "true";',
  "const delayed = false;",
);
harness = replaceOnce(
  harness,
  "const sizes = diagnostic || delayed ? [250] : [25, 250];",
  "const sizes = [250];",
);
harness = replaceOnce(harness, "const repetitions = diagnostic ? 1 : 3;", "const repetitions = 1;");
harness = replaceOnce(
  harness,
  "const settleMs = delayed ? 20_000 : 2_000;",
  `const settleMs = ${protocol.settleMs};`,
);
harness = replaceOnce(
  harness,
  "const observationMs = diagnostic ? 30_000 : delayed ? 10_000 : 5_000;",
  `const observationMs = ${protocol.observationMs};`,
);
harness = replaceOnce(
  harness,
  "}, 360_000);",
  `}, ${mode === "long-idle" ? 50 * 60_000 : 20 * 60_000});`,
);
harness = replaceOnce(
  harness,
  "Rendered resource comparison exceeded six minutes.",
  "Bounded follow-up watchdog expired.",
);
// Keep generated source/observer hashes beside the reports, not just hashes of original scripts.
observer = replaceOnce(
  observer,
  "      90_000,",
  `      ${mode === "long-idle" ? 25 * 60_000 : 90_000},`,
);
if (mode === "long-idle") {
  harness = replaceOnce(
    harness,
    "          await Bun.sleep(observationMs);\n          after = await sample(ready.procPid, pageSize);",
    `
          const points = [{ elapsedMs: 0, ...before }];
          const checkpoint = { label, points };
          const all = (report.checkpoints ??= []) as unknown[];
          all.push(checkpoint);
          for (let elapsed = ${interval}; elapsed <= observationMs; elapsed += ${interval}) {
            await Bun.sleep(Math.max(0, started + elapsed - performance.now()));
            lifetime.signal.throwIfAborted();
            after = await sample(ready.procPid, pageSize);
            points.push({ elapsedMs: performance.now() - started, ...after });
          }`,
  );
  harness = replaceOnce(
    harness,
    "...(diagnostic ? { memory: parseProcessMemoryStatus(status) } : {}),",
    "memory: parseProcessMemoryStatus(status),",
  );
} else {
  const wrapper = await readFile(resolve(import.meta.dir, "stability-tracker.mjs"), "utf8");
  const wrapperPath = join(generated, "tracker.mjs");
  const tracker = wrapper.replace('"CANDIDATE_PRODUCT_URL"', JSON.stringify(pathToFileURL(product).href));
  trackerSha256 = digest(tracker);
  await writeFile(wrapperPath, tracker);
  harness = replaceOnce(
    harness,
    "for (const enabled of repetition % 2 ? [false, true] : [true, false]) {",
    "for (const enabled of [true]) {",
  );
  harness = replaceOnce(
    harness,
    "SIDEBAR_RESOURCE_OUTPUT: output,",
    'SIDEBAR_RESOURCE_OUTPUT: output,\n            SIDEBAR_LIFECYCLE_COUNTERS: output + ".counters",',
  );
  harness = replaceOnce(
    harness,
    "          60_000,\n        );",
    "          15 * 60_000,\n        );",
  );
  observer = replaceOnce(
    observer,
    "for (let cycle = 0; cycle < 2; cycle++) {",
    `for (let cycle = 0; cycle < ${cycles}; cycle++) {\n        await Bun.sleep(5_500);`,
  );
  const quiet = `
        await Bun.sleep(7_500);
        const counters = JSON.parse(await readFile(output + ".counters", "utf8"));
        assert.equal(counters.liveEventListeners, 0, "Disposed activation retained public event listeners.");
        assert.equal(counters.pendingHealth, 0, "Disposed activation retained pending health requests.");
        assert.equal(counters.healthCallsAfterDisposal, 0, "Health request started after disposal.");
        assert.equal(counters.deliveredAfterDisposal, 0, "Public event delivered after disposal.");
        assert.equal(counters.activations, counters.disposals, "Activation disposal receipts differ.");
        assert.equal(counters.activations, cycleCheckpoints.length + 1, "Counter state reset across activations.");
        if (cycleCheckpoints.length < ${cycles}) {
          const previous = cycleCheckpoints.at(-1) as { counters: { healthCalls: number } } | undefined;
          assert(counters.healthCalls > (previous?.counters.healthCalls ?? 0), "Active interval did not exercise real health.");
        }
        const memory = process.memoryUsage();
        cycleCheckpoints.push({ cycle: cycleCheckpoints.length + 1, counters, memory, render: renderTreeStats() });
        await publish(output + ".cycles", { completed: false, cycleCheckpoints });
`;
  observer = replaceOnce(
    observer,
    '  const lifecycle: NonNullable<ResourceProbeResult["lifecycle"]> = [];',
    '  const lifecycle: NonNullable<ResourceProbeResult["lifecycle"]> = [];\n  const cycleCheckpoints: unknown[] = [];',
  );
  observer = replaceOnce(
    observer,
    '        await until(() => !sidebarVisible(), "Deactivation retained the sidebar.");',
    '        await until(() => !sidebarVisible(), "Deactivation retained the sidebar.");' + quiet,
  );
  observer = replaceOnce(
    observer,
    '      await until(() => !sidebarVisible(), "Final deactivation retained sidebar controls.");',
    '      await until(() => !sidebarVisible(), "Final deactivation retained sidebar controls.");' +
      quiet +
      `\n      assert.equal(cycleCheckpoints.length, ${cycles + 1});\n      await publish(output + ".cycles", { completed: true, cycleCheckpoints });`,
  );
  // No synthetic baseline or budget verdict for this lifecycle-only process.
  const begin = harness.indexOf("  const results = sizes.map((sessions) => {");
  const end = harness.indexOf("  report.results = results;", begin);
  assert(begin >= 0 && end > begin);
  harness =
    harness.slice(0, begin) +
    "  const results = measurements.map(m => ({ sessions: m.sessions, lifecycle: m.probe?.lifecycle }));\n" +
    harness.slice(end);
  harness = replaceOnce(
    harness,
    'const plugin = await realpath(process.env.SIDEBAR_PLUGIN_FILE ?? join(repository, "dist/tui.js"));',
    `const plugin = await realpath(${JSON.stringify(wrapperPath)});`,
  );
}
// Both follow-ups are observations, never substitute acceptance windows or budgets.
const acceptanceStart = harness.indexOf(
  "  if (!diagnostic) {\n    report.acceptanceEvaluated = true;",
);
const acceptanceEnd = harness.indexOf("  report.completed = true;", acceptanceStart);
assert(acceptanceStart >= 0 && acceptanceEnd > acceptanceStart);
harness =
  harness.slice(0, acceptanceStart) +
  `  report.kind = ${JSON.stringify(mode + (smoke ? "-smoke" : "-observation"))};\n  report.acceptanceEvaluated = false;\n  delete report.passed;\n  for (const value of results) delete (value as Record<string, unknown>).passed;\n` +
  harness.slice(acceptanceEnd);
harness = replaceOnce(
  harness,
  '  if (!diagnostic)\n    assert(report.passed, "Predeclared rendered-sidebar idle resource budgets did not all pass.");',
  "  // Original acceptance is evaluated only in the unchanged three-campaign jobs.",
);
// Copy small protocol/counter receipts even after failure; no profiles, databases or dependencies.
harness = replaceOnce(
  harness,
  "    await rm(root, { recursive: true, force: true });",
  `    await mkdir(${JSON.stringify(join(output, "receipts"))}, { recursive: true });\n    for (const name of await readdir(root)) {\n      if (/result\\.json(?:\\.|$)/.test(name)) await cp(join(root, name), join(${JSON.stringify(join(output, "receipts"))}, name));\n    }\n    await rm(root, { recursive: true, force: true });`,
);
for (const name of ["thread-cpu-diagnostic.ts", "process-memory-diagnostic.ts"]) {
  await writeFile(join(generated, name), await readFile(join(repository, "scripts", name)));
}
await writeFile(join(generated, "benchmark-sidebar-runtime.ts"), harness);
await writeFile(join(generated, "sidebar-resource-probe.ts"), observer);
await writeFile(
  join(output, "source-hashes.json"),
  JSON.stringify(
    {
      originalHashes,
      generatedHarness: digest(harness),
      generatedObserver: digest(observer),
      trackerSha256,
      productSha256,
    },
    null,
    2,
  ),
);
// Resolve the pinned candidate's dependencies when executing the generated harness.
const { symlink } = await import("node:fs/promises");
await symlink(join(repository, "node_modules"), join(generated, "node_modules"), "dir");
if (!prepareOnly) {
  const child = Bun.spawn([process.execPath, join(generated, "benchmark-sidebar-runtime.ts")], {
    cwd: repository,
    env: {
      ...process.env,
      SIDEBAR_PLUGIN_FILE: product,
      SIDEBAR_RESOURCE_REPORT: join(output, "report.json"),
    },
    stdout: Bun.file(join(output, "stdout.log")),
    stderr: Bun.file(join(output, "stderr.log")),
  });
  const code = await child.exited;
  const { unlink } = await import("node:fs/promises");
  await unlink(join(generated, "node_modules"));
  assert.equal(
    digest(await readFile(product)),
    productSha256,
    "Product changed during observation.",
  );
  await writeFile(join(output, "exit.json"), JSON.stringify({ code }));
  assert.equal(code, 0, "Follow-up failed; retain all reports and logs.");
}
