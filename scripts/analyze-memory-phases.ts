/**
 * CLI: reanalyze an existing phase-diagnostic `summary.json` into within-process deltas.
 *
 * Informative only; it never evaluates acceptance budgets. Reads the artifact a prior campaign
 * already produced, so it runs without a new host.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { reanalyzePhaseReport, type PhaseReport } from "./lib/memory-phase-reanalysis";

const input = process.argv[2] ?? process.env.SIDEBAR_PHASE_SUMMARY;
const output = process.argv[3] ?? process.env.SIDEBAR_PHASE_REANALYSIS;

if (!input) {
  console.error("usage: bun scripts/analyze-memory-phases.ts <summary.json> [output.json]");
  process.exitCode = 2;
} else {
  const report = JSON.parse(await readFile(resolve(input), "utf8")) as PhaseReport;
  const reanalysis = reanalyzePhaseReport(report);
  const serialized = `${JSON.stringify(reanalysis, null, 2)}\n`;
  if (output) await Bun.write(resolve(output), serialized);
  else process.stdout.write(serialized);
}
