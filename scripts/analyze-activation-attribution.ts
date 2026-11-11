/**
 * CLI: compute the activation-attribution verdict from a campaign `summary.json`.
 *
 * The headline verdict applies the unchanged RSS/CPU budgets to the total window (first import +
 * first activation + idle), using the paired difference-in-differences against the symmetric
 * control. Per-phase windows (import, activation, events, idle) are reported for diagnosis only.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  attributionCriteria,
  attributionWindows,
  type AttributionWindowName,
} from "./lib/attribution-criteria";
import {
  collectWindowSamples,
  decideVerdict,
  interquartileRange,
  median,
  type CampaignReport,
} from "./lib/memory-deltas";

const input = process.argv[2] ?? process.env.SIDEBAR_ATTRIBUTION_SUMMARY;
const output = process.argv[3] ?? process.env.SIDEBAR_ATTRIBUTION_VERDICT;

if (!input) {
  console.error(
    "usage: bun scripts/analyze-activation-attribution.ts <summary.json> [output.json]",
  );
  process.exitCode = 2;
} else {
  const report = JSON.parse(await readFile(resolve(input), "utf8")) as CampaignReport;
  const windowNames = Object.keys(attributionWindows) as AttributionWindowName[];
  const windows: Record<string, unknown> = {};
  for (const name of windowNames) {
    const window = attributionWindows[name];
    const samples = collectWindowSamples(
      report,
      window.from,
      window.to,
      attributionCriteria.warmupPairsDiscarded,
    );
    windows[name] = {
      from: window.from,
      to: window.to,
      evaluablePairs: samples.evaluablePairs,
      totalPairs: samples.totalPairs,
      droppedPairs: samples.droppedPairs,
      warmupDiscarded: samples.warmupDiscarded,
      rssMiB: { median: median(samples.rss), iqr: interquartileRange(samples.rss) },
      cpuPoints: { median: median(samples.cpu), iqr: interquartileRange(samples.cpu) },
    };
  }
  const total = collectWindowSamples(
    report,
    attributionWindows.total.from,
    attributionWindows.total.to,
    attributionCriteria.warmupPairsDiscarded,
  );
  const verdict = decideVerdict(
    { rss: total.rss, cpu: total.cpu },
    {
      budgetRssMiB: attributionCriteria.budget.rssMiB,
      budgetCpuPoints: attributionCriteria.budget.cpuPoints,
      signalIqrMultiple: attributionCriteria.signalIqrMultiple,
      minEvaluablePairs: attributionCriteria.minEvaluablePairs,
    },
  );
  const result = {
    kind: "activation-attribution-verdict",
    note: "Verdict is data, not acceptance: the PR stays draft and V1 acceptance is the owner's decision.",
    criteria: attributionCriteria,
    verdict,
    total: {
      evaluablePairs: total.evaluablePairs,
      totalPairs: total.totalPairs,
      droppedPairs: total.droppedPairs,
    },
    windows,
  };
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (output) await Bun.write(resolve(output), serialized);
  else process.stdout.write(serialized);
  console.log(
    `verdict=${verdict.verdict} rss_median=${verdict.rss.median.toFixed(4)} ` +
      `cpu_median=${verdict.cpu.median.toFixed(4)} evaluable=${verdict.evaluablePairs}`,
  );
}
