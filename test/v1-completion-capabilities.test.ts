import { describe, expect, test } from "bun:test";
import {
  parseV1CompletionPolicy,
  v1CompletionCapabilities,
} from "../src/adapters/opencode-v1/completion-capabilities";
import { resolve } from "node:path";
import { parseSidebarOptions } from "../src/ui/controller";

describe("V1 host completion capability", () => {
  test("preserves existing omitted configuration and explicit manual marking", () => {
    expect(parseV1CompletionPolicy(undefined)).toBe("manual");
    expect(parseV1CompletionPolicy("manual")).toBe("manual");
    expect(v1CompletionCapabilities.executionCorrelation).toBe("unavailable");
  });

  test("rejects automatic and custom requests with the host limitation and recovery", () => {
    for (const requested of ["automatic", "on-execution", "custom"]) {
      expect(() => parseV1CompletionPolicy(requested)).toThrow("execution identity");
      expect(() => parseV1CompletionPolicy(requested)).toThrow('completionPolicy: "manual"');
    }
  });

  test("does not coerce malformed options or execute a supplied policy function", () => {
    let invoked = false;
    const decide = () => {
      invoked = true;
      return "manual";
    };
    for (const requested of [null, false, 1, [], ["manual"], { mode: "manual" }, decide]) {
      expect(() => parseV1CompletionPolicy(requested)).toThrow("when supplied");
    }
    expect(() => parseV1CompletionPolicy({ toString: decide })).toThrow("when supplied");
    expect(invoked).toBe(false);
  });

  test("sidebar configuration does not silently discard an unsupported policy", () => {
    const base = { hostId: "synthetic-host", storageDirectory: resolve("synthetic-storage") };
    expect(parseSidebarOptions(base)).toEqual(base);
    expect(parseSidebarOptions({ ...base, completionPolicy: "manual" })).toEqual({
      ...base,
      completionPolicy: "manual",
    });
    for (const completionPolicy of ["automatic", "on-execution", "custom", ["manual"]]) {
      expect(() => parseSidebarOptions({ ...base, completionPolicy })).toThrow("completionPolicy");
    }
  });
});
