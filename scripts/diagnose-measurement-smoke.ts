/**
 * Phase 0: prove the diagnostic memory/CPU APIs exist and behave in the pinned Bun build.
 *
 * This is a cheap gate that runs before any campaign. It never measures the product and never
 * touches a host process; it only asserts that `bun:jsc` heap statistics, allocator commit,
 * process CPU accounting and the GC log switch are usable. If a required API is missing the
 * campaign design must change before spending runner minutes.
 */

import { heapStats, memoryUsage } from "bun:jsc";

interface ApiCheck {
  readonly name: string;
  readonly required: boolean;
  readonly present: boolean;
  readonly detail: string;
}

function probeHeapStats(): ApiCheck {
  try {
    const stats = heapStats() as any;
    const present =
      typeof stats?.heapSize === "number" &&
      typeof stats?.heapCapacity === "number" &&
      typeof stats?.objectTypeCounts === "object";
    return {
      name: "bun:jsc.heapStats (heapSize, heapCapacity, objectTypeCounts)",
      required: true,
      present,
      detail: present ? "objectTypeCounts available for per-type live-set deltas" : "unexpected shape",
    };
  } catch (error) {
    return { name: "bun:jsc.heapStats", required: true, present: false, detail: String(error) };
  }
}

function probeMemoryUsage(): ApiCheck {
  try {
    const usage = memoryUsage() as any;
    const present = typeof usage?.currentCommit === "number";
    return {
      name: "bun:jsc.memoryUsage (currentCommit)",
      required: true,
      present,
      detail: present ? `currentCommit=${usage.currentCommit}` : "currentCommit missing",
    };
  } catch (error) {
    return { name: "bun:jsc.memoryUsage", required: true, present: false, detail: String(error) };
  }
}

function probeCpuUsage(): ApiCheck {
  const fn = (process as any).cpuUsage;
  if (typeof fn !== "function")
    return { name: "process.cpuUsage", required: true, present: false, detail: "not a function" };
  try {
    const usage = fn();
    return {
      name: "process.cpuUsage",
      required: true,
      present: true,
      detail: `user=${usage.user} system=${usage.system} microseconds`,
    };
  } catch (error) {
    return { name: "process.cpuUsage", required: true, present: false, detail: String(error) };
  }
}

function probeThreadCpuUsage(): ApiCheck {
  const present = typeof (process as any).threadCpuUsage === "function";
  return {
    name: "process.threadCpuUsage (optional per-thread fallback)",
    required: false,
    present,
    detail: present ? "available" : "not available in this Bun build; use whole-process CPU",
  };
}

function probeLogGC(): ApiCheck {
  const value = process.env.BUN_JSC_logGC;
  return {
    name: "BUN_JSC_logGC (GC observability, set by the runner)",
    required: false,
    present: value !== undefined,
    detail: value === undefined ? "not set in this environment" : `value=${value}`,
  };
}

const checks = [
  probeHeapStats(),
  probeMemoryUsage(),
  probeCpuUsage(),
  probeThreadCpuUsage(),
  probeLogGC(),
];
const missingRequired = checks
  .filter((check) => check.required && !check.present)
  .map((check) => check.name);

const report = {
  kind: "measurement-api-smoke",
  bunVersion: Bun.version,
  platform: process.platform,
  arch: process.arch,
  checks,
  requiredPresent: missingRequired.length === 0,
  missingRequired,
  completed: true,
};

const serialized = `${JSON.stringify(report, null, 2)}\n`;
const output = process.env.SIDEBAR_SMOKE_OUTPUT;
if (output) await Bun.write(output, serialized);
else process.stdout.write(serialized);

if (missingRequired.length > 0) {
  console.error(`Missing required measurement APIs: ${missingRequired.join(", ")}`);
  process.exitCode = 1;
}
