/**
 * CLI: summarize one or more captured `.cpuprofile` files into self-time buckets.
 *
 * Usage: `bun scripts/analyze-cpu-profile.ts <profile...> [--out summary.json]`. With `--out` it
 * writes the JSON summary to that path and prints a human table; without it, it prints the JSON to
 * stdout. It never decides acceptance — it only reports where the sampled CPU went.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { summarizeProfile } from "./lib/cpu-profile-analysis";

const args = process.argv.slice(2);
const inputs: string[] = [];
let output: string | undefined;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]!;
  if (arg === "--out") {
    output = args[index + 1];
    index += 1;
  } else {
    inputs.push(arg);
  }
}

if (inputs.length === 0) {
  console.error(
    "usage: bun scripts/analyze-cpu-profile.ts <profile.json ...> [--out summary.json]",
  );
  process.exitCode = 2;
} else {
  const profiles: unknown[] = [];
  for (const input of inputs) {
    const profile = JSON.parse(await readFile(resolve(input), "utf8"));
    const summary = summarizeProfile(profile);
    profiles.push({ input, ...summary });
    if (output) {
      console.log(`== ${input} total=${(summary.totalMicros / 1000).toFixed(1)}ms`);
      for (const bucket of summary.buckets) {
        console.log(
          `  ${bucket.bucket.padEnd(14)} ${(bucket.selfMicros / 1000).toFixed(1)}ms (${bucket.samples})`,
        );
      }
      for (const frame of summary.topFrames.slice(0, 8)) {
        console.log(
          `    ${(frame.selfMicros / 1000).toFixed(1)}ms ${frame.functionName} ${frame.url}:${frame.line}`,
        );
      }
    }
  }
  const serialized = `${JSON.stringify({ kind: "cpu-profile-summary", profiles }, null, 2)}\n`;
  if (output) await Bun.write(resolve(output), serialized);
  else process.stdout.write(serialized);
}
