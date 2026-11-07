import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PerfAckDecoder, runBoundedProcess } from "./native-perf";

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

test.skipIf(process.platform !== "linux")(
  "analysis timeout terminates its owned helper process group",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "sidebar-analysis-group-"));
    try {
      const fixture = join(directory, "fixture.ts");
      const receipt = join(directory, "children.json");
      await writeFile(
        fixture,
        `
const helper = Bun.spawn([process.execPath, "-e", "setTimeout(() => process.exit(0), 10000); setInterval(() => {}, 1000)"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
await Bun.write(process.argv[2], JSON.stringify({ helperPid: helper.pid }));
setTimeout(() => process.exit(0), 10000);
setInterval(() => {}, 1000);
`,
      );
      const result = await runBoundedProcess([process.execPath, fixture, receipt], {
        stdout: join(directory, "stdout.txt"),
        stderr: join(directory, "stderr.txt"),
        timeoutMs: 1_000,
      });
      expect(result.timedOut).toBe(true);
      expect(result.groupCleanupSent).toBe(true);
      expect(result.exitCode).not.toBe(0);
      const { helperPid } = JSON.parse(await readFile(receipt, "utf8")) as { helperPid: number };
      let running = true;
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          const status = await readFile(`/proc/${helperPid}/stat`, "utf8");
          running = status.slice(status.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          running = false;
        }
        if (!running) break;
        await Bun.sleep(10);
      }
      expect(running).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
