/** Diagnostic-only Linux thread counters; never used by resource acceptance sampling. */
import { readFile, readdir } from "node:fs/promises";

export const threadDiagnosticLimits = { maxThreads: 128, readConcurrency: 8 } as const;

export interface ThreadCounter {
  tid: number;
  name: string;
  startTimeTicks: number;
  cpuTicks: number;
}

export interface ThreadSnapshot {
  startedMs: number;
  finishedMs: number;
  enumeratedThreads: number;
  truncatedThreads: number;
  enumerationFailed: boolean;
  unreadableTids: number[];
  threads: ThreadCounter[];
}

export function parseThreadStat(stat: string, expectedTid: number): ThreadCounter {
  const open = stat.indexOf("(");
  const close = stat.lastIndexOf(")");
  const tid = Number(stat.slice(0, open).trim());
  // comm can contain spaces and parentheses. Remaining fields begin at field 3 (state).
  const fields = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const userTicks = Number(fields[11]);
  const systemTicks = Number(fields[12]);
  const startTimeTicks = Number(fields[19]);
  if (
    open < 1 ||
    close <= open ||
    tid !== expectedTid ||
    ![tid, userTicks, systemTicks, startTimeTicks].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ) ||
    !Number.isSafeInteger(userTicks + systemTicks)
  )
    throw new Error("Invalid thread stat counters.");
  return {
    tid,
    name: stat
      .slice(open + 1, close)
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, "?")
      .slice(0, 64),
    startTimeTicks,
    cpuTicks: userTicks + systemTicks,
  };
}

export async function sampleThreads(pid: number, originMs: number): Promise<ThreadSnapshot> {
  const result: ThreadSnapshot = {
    startedMs: performance.now() - originMs,
    finishedMs: 0,
    enumeratedThreads: 0,
    truncatedThreads: 0,
    enumerationFailed: false,
    unreadableTids: [],
    threads: [],
  };
  let tids: number[];
  try {
    tids = (await readdir(`/proc/${pid}/task`))
      .filter((name) => /^\d+$/.test(name))
      .map(Number)
      .sort((a, b) => a - b);
  } catch {
    result.enumerationFailed = true;
    result.finishedMs = performance.now() - originMs;
    return result;
  }
  result.enumeratedThreads = tids.length;
  result.truncatedThreads = Math.max(0, tids.length - threadDiagnosticLimits.maxThreads);
  tids = tids.slice(0, threadDiagnosticLimits.maxThreads);
  for (let offset = 0; offset < tids.length; offset += threadDiagnosticLimits.readConcurrency) {
    await Promise.all(
      tids.slice(offset, offset + threadDiagnosticLimits.readConcurrency).map(async (tid) => {
        try {
          const stat = await readFile(`/proc/${pid}/task/${tid}/stat`, "utf8");
          result.threads.push(parseThreadStat(stat, tid));
        } catch {
          // Exits between enumeration and read are normal; do not invent zero CPU for them.
          result.unreadableTids.push(tid);
        }
      }),
    );
  }
  result.threads.sort((a, b) => a.tid - b.tid);
  result.unreadableTids.sort((a, b) => a - b);
  result.finishedMs = performance.now() - originMs;
  return result;
}

export function compareThreadSnapshots(
  before: ThreadSnapshot,
  after: ThreadSnapshot,
  clockTicks: number,
) {
  const intervalMs =
    (after.startedMs + after.finishedMs - before.startedMs - before.finishedMs) / 2;
  if (!(intervalMs > 0) || !(clockTicks > 0))
    throw new Error("Invalid thread diagnostic interval.");
  const identity = (thread: ThreadCounter) => `${thread.tid}:${thread.startTimeTicks}`;
  const previous = new Map(before.threads.map((thread) => [identity(thread), thread]));
  const current = new Set(after.threads.map(identity));
  const matched: {
    tid: number;
    name: string;
    previousName: string;
    startTimeTicks: number;
    cpuTicks: number;
    cpuPercent: number;
  }[] = [];
  const newlyObserved: ThreadCounter[] = [];
  const regressedCounters: number[] = [];
  for (const thread of after.threads) {
    const old = previous.get(identity(thread));
    if (!old) newlyObserved.push(thread);
    else if (thread.cpuTicks < old.cpuTicks) regressedCounters.push(thread.tid);
    else {
      const cpuTicks = thread.cpuTicks - old.cpuTicks;
      matched.push({
        tid: thread.tid,
        name: thread.name,
        previousName: old.name,
        startTimeTicks: thread.startTimeTicks,
        cpuTicks,
        cpuPercent: (cpuTicks * 100_000) / clockTicks / intervalMs,
      });
    }
  }
  matched.sort((a, b) => b.cpuTicks - a.cpuTicks || a.tid - b.tid);
  return {
    intervalMs,
    matchedCpuPercent: matched.reduce((sum, thread) => sum + thread.cpuPercent, 0),
    matched,
    newlyObserved,
    noLongerObserved: before.threads.filter((thread) => !current.has(identity(thread))),
    regressedCounters,
    // Even complete endpoints miss threads created and exited between snapshots. Sampling is
    // non-atomic and slightly offset from the process counters; this is attribution, not a total.
    attributionComplete: false as const,
  };
}
