import { describe, expect, test } from "bun:test";
import { parseProcessMemoryStatus } from "../scripts/process-memory-diagnostic";

describe("diagnostic process memory status", () => {
  test("reads kernel KiB counters and keeps measured zero distinct from unavailable", () => {
    const result = parseProcessMemoryStatus(
      "Name:\topencode\nRssAnon:\t2048 kB\nRssFile: 512 kB\nRssShmem:\t0 kB\nVmSwap:\t0 kB\n",
    );
    expect(result.RssAnon).toEqual({ status: "available", kiB: 2048, miB: 2 });
    expect(result.RssFile).toEqual({ status: "available", kiB: 512, miB: 0.5 });
    expect(result.RssShmem).toEqual({ status: "available", kiB: 0, miB: 0 });
    expect(result.VmSwap).toEqual({ status: "available", kiB: 0, miB: 0 });
  });

  test("unsupported or missing fields remain explicit without using total RSS as a substitute", () => {
    const result = parseProcessMemoryStatus("VmRSS: 8192 kB\nRssAnon:\t1024 kB\n");
    expect(result.RssAnon).toEqual({ status: "available", kiB: 1024, miB: 1 });
    for (const field of ["RssFile", "RssShmem", "VmSwap"] as const)
      expect(result[field]).toEqual({ status: "unavailable", reason: "missing" });
  });

  test("rejects unexpected units, negative, fractional, missing and unsafe values", () => {
    for (const value of ["4 MB", "-1 kB", "1.5 kB", "kB", "12", "9007199254740992 kB"])
      expect(parseProcessMemoryStatus(`RssAnon: ${value}\n`).RssAnon).toEqual({
        status: "unavailable",
        reason: "invalid",
      });
  });

  test("duplicates cannot silently choose one conflicting sample", () => {
    const result = parseProcessMemoryStatus("RssFile: 4096 kB\nRssFile: 0 kB\nVmSwap: 2 kB");
    expect(result.RssFile).toEqual({ status: "unavailable", reason: "duplicate" });
    expect(result.VmSwap).toEqual({ status: "available", kiB: 2, miB: 2 / 1024 });
    expect(parseProcessMemoryStatus("OtherRssAnon: 1 kB").RssAnon).toEqual({
      status: "unavailable",
      reason: "missing",
    });
  });
});
