/**
 * CLI: compute the steady-state idle verdict from a diagnostic `summary.json`.
 *
 * Unlike the activation analyzer, this one measures ONLY sustained idle: its window runs from the
 * post-settle snapshot to the end of the idle observation, so the settling transient that follows
 * seeding the host and the first render is excluded. The unchanged RSS/CPU budgets are applied to
 * that window; a metric over budget but below the signal threshold is INCONCLUSIVE, never a false
 * PASS or a false FAIL. The verdict is data, not an acceptance receipt.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { attributionCriteria } from "./lib/attribution-criteria";
import {
  collectWindowSamples,
  decideVerdict,
  interquartileRange,
  median,
  type CampaignReport,
} from "./lib/memory-deltas";

/** Start of the steady window: the post-settle snapshot taken after the settling transient. */
const FROM = "settled";
/** End of the steady window: the end of the idle observation. */
const TO = "ready+idle";

const input = process.argv[2] ?? process.env.SIDEBAR_STEADY_SUMMARY;
const output = process.argv[3] ?? process.env.SIDEBAR_STEADY_VERDICT;

if (!input) {
  console.error("usage: bun scripts/analyze-idle-steady-state.ts <summary.json> [output.json]");
  process.exitCode = 2;
} else {
  const report = JSON.parse(await readFile(resolve(input), "utf8")) as CampaignReport;
  const samples = collectWindowSamples(
    report,
    FROM,
    TO,
    attributionCriteria.warmupPairsDiscarded,
  );
  const verdict = decideVerdict(
    { rss: samples.rss, cpu: samples.cpu },
    {
      budgetRssMiB: attributionCriteria.budget.rssMiB,
      budgetCpuPoints: attributionCriteria.budget.cpuPoints,
      signalIqrMultiple: attributionCriteria.signalIqrMultiple,
      minEvaluablePairs: attributionCriteria.minEvaluablePairs,
    },
  );
  const result = {
    kind: "idle-steady-state-verdict",
    note: "Sustained idle only (post-settle to end of idle); verdict is data, not acceptance.",
    window: { from: FROM, to: TO },
    criteria: {
      pairs: attributionCriteria.pairs,
      warmupPairsDiscarded: attributionCriteria.warmupPairsDiscarded,
      minEvaluablePairs: attributionCriteria.minEvaluablePairs,
      budget: attributionCriteria.budget,
      signalIqrMultiple: attributionCriteria.signalIqrMultiple,
      idleMs: attributionCriteria.windows.idleMs,
    },
    evaluablePairs: samples.evaluablePairs,
    totalPairs: samples.totalPairs,
    droppedPairs: samples.droppedPairs,
    warmupDiscarded: samples.warmupDiscarded,
    cpuPoints: { median: median(samples.cpu), iqr: interquartileRange(samples.cpu) },
    rssMiB: { median: median(samples.rss), iqr: interquartileRange(samples.rss) },
    verdict,
  };
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (output) await Bun.write(resolve(output), serialized);
  else process.stdout.write(serialized);
  console.log(
    `steady_verdict=${verdict.verdict} cpu_median=${verdict.cpu.median.toFixed(4)} ` +
      `rss_median=${verdict.rss.median.toFixed(4)} evaluable=${verdict.evaluablePairs}`,
  );
}
