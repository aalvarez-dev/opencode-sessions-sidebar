import { describe, expect, test } from "bun:test";
import {
  compareThreadSnapshots,
  parseThreadStat,
  type ThreadCounter,
  type ThreadSnapshot,
} from "../scripts/thread-cpu-diagnostic";

function stat(tid: number, name: string, user: string, system: string, start = "1234") {
  const fields = Array<string>(22).fill("0");
  fields[0] = "S";
  fields[11] = user;
  fields[12] = system;
  fields[19] = start;
  return `${tid} (${name}) ${fields.join(" ")}`;
}

function thread(tid: number, cpuTicks: number, startTimeTicks = 1234): ThreadCounter {
  return { tid, cpuTicks, startTimeTicks, name: `thread-${tid}` };
}

function snapshot(at: number, threads: ThreadCounter[]): ThreadSnapshot {
  return {
    startedMs: at,
    finishedMs: at + 2,
    enumeratedThreads: threads.length,
    truncatedThreads: 0,
    enumerationFailed: false,
    unreadableTids: [],
    threads,
  };
}

describe("diagnostic thread CPU attribution", () => {
  test("parses comm with nested parentheses/spaces without shifting CPU or start-time fields", () => {
    expect(parseThreadStat(stat(81, "JSC (worker) )", "20", "3"), 81)).toEqual({
      tid: 81,
      name: "JSC (worker) )",
      startTimeTicks: 1234,
      cpuTicks: 23,
    });
    expect(parseThreadStat(stat(81, "name\n\u001b", "0", "0"), 81).name).toBe("name??");
  });

  test("rejects a different identity, missing, negative, nonnumeric or unsafe counters", () => {
    for (const value of [
      stat(82, "worker", "1", "2"),
      "81 (worker) S 0",
      stat(81, "worker", "-1", "2"),
      stat(81, "worker", "bad", "2"),
      stat(81, "worker", "9007199254740991", "2"),
      stat(81, "worker", "1", "2", "-1"),
    ])
      expect(() => parseThreadStat(value, 81)).toThrow("Invalid thread stat");
  });

  test("attributes only persistent identities, preserving newly/missing/reused TIDs", () => {
    const before = snapshot(0, [thread(1, 100), thread(2, 80), thread(3, 50)]);
    const after = snapshot(1000, [thread(1, 103), thread(3, 7, 9000), thread(4, 10)]);
    const result = compareThreadSnapshots(before, after, 100);
    expect(result.intervalMs).toBe(1000);
    expect(result.matchedCpuPercent).toBe(3);
    expect(result.matched.map((row) => row.tid)).toEqual([1]);
    expect(result.newlyObserved.map((row) => row.tid)).toEqual([3, 4]);
    expect(result.noLongerObserved.map((row) => row.tid)).toEqual([2, 3]);
    expect(result.attributionComplete).toBe(false);
  });

  test("a failed or capped endpoint never turns absent counters into zero CPU", () => {
    const before = snapshot(0, [thread(1, 100), thread(2, 50)]);
    const after = snapshot(1000, [thread(1, 101)]);
    after.unreadableTids = [2];
    after.truncatedThreads = 2;
    const result = compareThreadSnapshots(before, after, 100);
    expect(result.matchedCpuPercent).toBe(1);
    expect(result.noLongerObserved.map((row) => row.tid)).toEqual([2]);
    const failed = { ...snapshot(2000, []), enumerationFailed: true };
    expect(compareThreadSnapshots(after, failed, 100).matched).toEqual([]);
    expect(compareThreadSnapshots(after, failed, 100).attributionComplete).toBe(false);
  });

  test("flags counter regressions and rejects invalid timing", () => {
    const before = snapshot(0, [thread(1, 100)]);
    const after = snapshot(1000, [thread(1, 80)]);
    const result = compareThreadSnapshots(before, after, 100);
    expect(result.regressedCounters).toEqual([1]);
    expect(result.matched).toEqual([]);
    expect(() => compareThreadSnapshots(before, before, 100)).toThrow("Invalid thread");
    expect(() => compareThreadSnapshots(before, after, 0)).toThrow("Invalid thread");
  });
});
