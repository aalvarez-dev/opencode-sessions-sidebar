import assert from "node:assert/strict";
import { controllerFixture, syntheticSession } from "../test/fixtures/ui-controller";

// Predeclared component budget: 250 sessions, 500 activity changes plus 500 inert
// token events in <=500ms, with no additional SDK reads. This is the real Solid
// controller/read model with synthetic public host ports, not a terminal renderer,
// stock-OpenCode process comparison, or optional-metadata/network latency test.
// Run with: bun --conditions=browser scripts/benchmark-sidebar.ts
const sessionCount = 250;
const updateCount = 500;
const burstBudgetMs = 500;
const fixture = await controllerFixture();
const { host, controller } = fixture;
try {
  host.sessions = Array.from({ length: sessionCount }, (_, index) => {
    const session = syntheticSession(`session-${index}`);
    return { ...session, time: { created: index, updated: index } };
  });
  await controller.connect(host.directory);
  assert.equal(controller.state()?.phase, "ready");
  assert.equal(controller.rows().length, sessionCount);
  const initialCalls = { ...host.calls };
  let previousRows = controller.rows();
  let changedRows = 0;
  let inertRecomputations = 0;
  const samples: number[] = [];
  const started = performance.now();
  for (let index = 0; index < updateCount; index++) {
    const sessionID = `session-${index % sessionCount}`;
    const before = performance.now();
    host.status(`activity-${index}`, sessionID, {
      type: index < sessionCount ? "busy" : "idle",
    });
    const groups = controller.groups();
    const rows = controller.rows();
    for (let row = 0; row < rows.length; row++) if (rows[row] !== previousRows[row]) changedRows++;
    previousRows = rows;
    host.emit({
      id: `token-${index}`,
      type: "message.part.delta",
      properties: { sessionID, messageID: "message", partID: "part", field: "text", delta: "x" },
    });
    if (controller.groups() !== groups) inertRecomputations++;
    samples.push(performance.now() - before);
  }
  const burstMs = performance.now() - started;
  const additionalReads =
    host.calls.project -
    initialCalls.project +
    host.calls.list -
    initialCalls.list +
    host.calls.status -
    initialCalls.status +
    host.calls.permissions -
    initialCalls.permissions +
    host.calls.questions -
    initialCalls.questions;
  const finalSummary = controller.groups()[2]!.summary;
  controller.dispose();
  samples.sort((a, b) => a - b);
  const passed =
    burstMs <= burstBudgetMs &&
    additionalReads === 0 &&
    changedRows === updateCount &&
    inertRecomputations === 0 &&
    finalSummary.busy === 0 &&
    host.subscriptions === 0 &&
    host.disposers.size === 0;
  const report = {
    scope: "synthetic-reactive-controller",
    environment: { platform: process.platform, arch: process.arch, bun: Bun.version },
    sessionCount,
    activityUpdates: updateCount,
    inertTokenEvents: updateCount,
    budget: { burstMs: burstBudgetMs, additionalReads: 0 },
    observed: {
      burstMs,
      updateP50Ms: samples[Math.floor(samples.length * 0.5)],
      updateP95Ms: samples[Math.floor(samples.length * 0.95)],
      initialReads: initialCalls,
      additionalReads,
      changedRows,
      inertRecomputations,
      subscriptionsAfterDisposal: host.subscriptions,
      lifecycleCallbacksAfterDisposal: host.disposers.size,
    },
    passed,
  };
  console.log(JSON.stringify(report, null, 2));
  assert.equal(passed, true, "Sidebar component performance or lifecycle budget exceeded");
} finally {
  await fixture.dispose();
}
