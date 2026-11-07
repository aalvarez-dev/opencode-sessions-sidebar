import { describe, expect, test } from "bun:test";
import { PerfAckDecoder } from "./native-perf";

const bytes = (value: string) => new TextEncoder().encode(value);

describe("Linux perf control acknowledgement framing", () => {
  test("handles the documented acknowledgement and the terminating NUL in every split", () => {
    const reply = "ack\n\0";
    for (let split = 0; split <= reply.length; split++) {
      const decoder = new PerfAckDecoder();
      const count =
        decoder.push(bytes(reply.slice(0, split))) + decoder.push(bytes(reply.slice(split)));
      expect(count).toBe(1);
      expect(decoder.push(bytes("ack\n\0"))).toBe(1);
    }
  });

  test("does not acknowledge a partial reply or mistake a delayed NUL for another reply", () => {
    const decoder = new PerfAckDecoder();
    expect(decoder.push(bytes("a"))).toBe(0);
    expect(decoder.push(bytes("ck"))).toBe(0);
    expect(decoder.push(bytes("\n"))).toBe(1);
    expect(decoder.push(bytes("\0a"))).toBe(0);
    expect(decoder.push(bytes("ck\n\0"))).toBe(1);
  });

  test("exposes duplicate replies for the single-outstanding-command guard", () => {
    expect(new PerfAckDecoder().push(bytes("ack\n\0ack\n\0"))).toBe(2);
  });

  test("rejects malformed replies rather than silently proceeding without synchronization", () => {
    expect(() => new PerfAckDecoder().push(bytes("nack\n"))).toThrow();
    const decoder = new PerfAckDecoder();
    decoder.push(bytes("ac"));
    expect(() => decoder.push(bytes("X\n"))).toThrow();
  });
});
