/** Bounded, userspace-only profiling of the synthetic TUI owned by this harness. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, createReadStream, openSync, readSync, writeSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { dlopen, FFIType, ptr } from "bun:ffi";

export const nativeProfileProtocol = {
  event: "cpu-clock:u",
  frequencyHz: 199,
  callGraph: "dwarf,16384",
  clock: "CLOCK_MONOTONIC",
  commandTimeoutMs: 10_000,
  captureTimeoutSeconds: 120,
  threadScope: "Existing TUI threads only; --no-inherit excludes future threads and subprocesses.",
} as const;

/** Linux perf 6.8 writes ack\n followed by NUL; either may cross a read boundary. */
export class PerfAckDecoder {
  private pending = "";
  push(bytes: Uint8Array): number {
    this.pending += new TextDecoder().decode(bytes);
    let acknowledgements = 0;
    while (this.pending.length) {
      if (this.pending[0] === "\0") {
        this.pending = this.pending.slice(1);
        continue;
      }
      if (this.pending.startsWith("ack\n")) {
        acknowledgements++;
        this.pending = this.pending.slice(4);
        continue;
      }
      assert("ack\n".startsWith(this.pending), "Unexpected perf control reply.");
      break;
    }
    return acknowledgements;
  }
}

function openClock() {
  return dlopen("libc.so.6", {
    clock_gettime: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  } as const);
}
let libc: ReturnType<typeof openClock> | undefined;
function monotonicMs() {
  libc ??= openClock();
  const timespec = new BigInt64Array(2);
  assert.equal(libc.symbols.clock_gettime!(1, ptr(timespec)), 0, "clock_gettime failed.");
  return Number(timespec[0]) * 1_000 + Number(timespec[1]) / 1_000_000;
}

async function hashFile(path: string) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}
const captures = new Set<NativePerfCapture>();

interface SymbolReceipt {
  completed: boolean;
  canResolveMatchingNativeTextSymbols: boolean;
  runtimeExecutablePath: string;
  runtimeExecutableSha256: string;
  symbolFilePath: string;
  symbolFileSha256: string;
  profileBuildId: string;
  profileTextSha256: string;
}

export async function verifyNativeSymbols(executable: string) {
  const reportPath = process.env.SIDEBAR_NATIVE_SYMBOL_REPORT;
  const symbolPath = process.env.SIDEBAR_NATIVE_SYMBOL_FILE;
  assert(reportPath && symbolPath, "Supply the verified native symbol receipt and file.");
  const report = JSON.parse(await readFile(reportPath, "utf8")) as SymbolReceipt;
  assert(report.completed && report.canResolveMatchingNativeTextSymbols);
  assert.equal(await realpath(symbolPath), await realpath(report.symbolFilePath));
  assert.equal(await hashFile(symbolPath), report.symbolFileSha256);
  assert.equal(await hashFile(executable), report.runtimeExecutableSha256);
  assert.match(report.profileBuildId, /^[0-9a-f]{40}$/);
  assert.match(report.profileTextSha256, /^[0-9a-f]{64}$/);
  return report;
}

export class NativePerfCapture {
  private child?: ReturnType<typeof Bun.spawn>;
  private control: number | undefined;
  private acknowledgement: number | undefined;
  private decoder = new PerfAckDecoder();
  private commandPending = false;
  private finished = false;
  private readonly commands: object[] = [];
  private readonly marks: object[] = [];
  private readonly directory: string;
  private readonly privileged: boolean;
  private readonly perf: string;
  private readonly cache: string;
  private readonly controlDirectory: string;
  private readonly receipt: Record<string, unknown>;
  private startTimeTicks?: string;

  constructor(
    private readonly pid: number,
    label: string,
    private readonly signal: AbortSignal,
  ) {
    assert(Number.isSafeInteger(pid) && pid > 1, "Expected an owned synthetic TUI PID.");
    assert(/^[a-z0-9-]+$/.test(label));
    assert(
      process.env.PERF_BIN &&
        process.env.SIDEBAR_NATIVE_OUTPUT &&
        process.env.SIDEBAR_NATIVE_PERF_CACHE,
    );
    this.perf = resolve(process.env.PERF_BIN);
    this.directory = join(resolve(process.env.SIDEBAR_NATIVE_OUTPUT), label);
    this.cache = resolve(process.env.SIDEBAR_NATIVE_PERF_CACHE);
    this.controlDirectory = join(this.cache, "control", `${label}-${pid}-${randomUUID()}`);
    assert([undefined, "false", "true"].includes(process.env.SIDEBAR_NATIVE_PERF_SUDO));
    this.privileged = process.env.SIDEBAR_NATIVE_PERF_SUDO === "true";
    this.receipt = {
      kind: "owned-tui-native-profile",
      acceptanceEvaluated: false,
      completed: false,
      pid,
      label,
      protocol: nativeProfileProtocol,
      privilegeMode: this.privileged ? "predeclared-isolated-runner-sudo" : "current-user",
      commands: this.commands,
      marks: this.marks,
    };
  }

  private async save() {
    await writeFile(
      join(this.directory, "capture.json"),
      JSON.stringify(this.receipt, null, 2) + "\n",
    );
  }

  private async identity() {
    const status = await readFile(`/proc/${this.pid}/status`, "utf8");
    assert.equal(Number(status.match(/^Pid:\s+(\d+)/m)?.[1]), this.pid);
    const uids = status.match(/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m);
    assert(uids && process.getuid && process.geteuid);
    assert.equal(
      Number(uids[1]),
      process.getuid(),
      "The synthetic TUI must belong to this runner.",
    );
    assert.equal(Number(uids[2]), process.geteuid(), "Unexpected synthetic TUI effective UID.");
    const contents = await readFile(`/proc/${this.pid}/stat`, "utf8");
    const fields = contents
      .slice(contents.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
    const startTime = fields[19];
    assert(startTime && /^\d+$/.test(startTime));
    if (this.startTimeTicks !== undefined)
      assert.equal(startTime, this.startTimeTicks, "The owned TUI PID was reused.");
    else this.startTimeTicks = startTime;
    this.receipt.processStartTimeTicks = startTime;
    this.receipt.uid = Number(uids[1]);
  }

  private async run(args: string[], name: string, timeout = 30_000) {
    const child = Bun.spawn(args, {
      stdout: Bun.file(join(this.directory, `${name}.stdout.txt`)),
      stderr: Bun.file(join(this.directory, `${name}.stderr.txt`)),
      env: { ...process.env, DEBUGINFOD_URLS: "" },
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    try {
      assert.equal(await child.exited, 0, `${name} failed; inspect retained output.`);
    } finally {
      clearTimeout(timer);
    }
  }

  async prepare() {
    await mkdir(this.directory, { recursive: true });
    await this.save();
    captures.add(this);
    try {
      this.signal.throwIfAborted();
      await this.identity();
      await mkdir(this.cache, { recursive: true });
      const cacheRelative = relative(
        await realpath(process.env.SIDEBAR_NATIVE_OUTPUT!),
        await realpath(this.cache),
      );
      assert(
        cacheRelative === ".." || cacheRelative.startsWith("../") || isAbsolute(cacheRelative),
        "Keep the large native symbol cache outside uploaded evidence.",
      );
      const runtime = await realpath(`/proc/${this.pid}/exe`);
      const symbols = await verifyNativeSymbols(runtime);
      this.receipt.symbolIdentity = symbols;
      this.receipt.initialThreads = (await readdir(`/proc/${this.pid}/task`))
        .filter((name) => /^\d+$/.test(name))
        .map(Number);
      await mkdir(this.controlDirectory, { recursive: true });
      const controlPath = join(this.controlDirectory, "control.fifo");
      const ackPath = join(this.controlDirectory, "ack.fifo");
      await this.run(["mkfifo", "--mode=600", controlPath, ackPath], "fifo");
      this.control = openSync(controlPath, constants.O_RDWR | constants.O_NONBLOCK);
      this.acknowledgement = openSync(ackPath, constants.O_RDWR | constants.O_NONBLOCK);
      const record = [
        this.perf,
        "record",
        "--event",
        nativeProfileProtocol.event,
        "--freq",
        String(nativeProfileProtocol.frequencyHz),
        "--pid",
        String(this.pid),
        "--no-inherit",
        "--call-graph",
        nativeProfileProtocol.callGraph,
        "--clockid=mono",
        "--delay=-1",
        `--control=fifo:${controlPath},${ackPath}`,
        "--no-buildid-cache",
        "--output",
        join(this.directory, "perf.data"),
      ];
      const bounded = [
        "timeout",
        "--signal=INT",
        "--kill-after=5s",
        `${nativeProfileProtocol.captureTimeoutSeconds}s`,
        ...record,
      ];
      const args = this.privileged ? ["sudo", "-n", "--", ...bounded] : bounded;
      this.receipt.recordArgv = args;
      this.child = Bun.spawn(args, {
        stdout: Bun.file(join(this.directory, "record.stdout.txt")),
        stderr: Bun.file(join(this.directory, "record.stderr.txt")),
        env: { ...process.env, DEBUGINFOD_URLS: "" },
      });
      await this.command("ping");
      await this.save();
    } catch (error) {
      this.receipt.failure = String(error);
      this.receipt.blocked = true;
      await this.save();
      throw error;
    }
  }

  private async command(command: "ping" | "enable" | "disable" | "stop") {
    assert(!this.commandPending, "Only one perf control command may be outstanding.");
    assert(this.control !== undefined && this.acknowledgement !== undefined && this.child);
    this.commandPending = true;
    const receipt: Record<string, unknown> = { command, sentMonotonicMs: monotonicMs() };
    this.commands.push(receipt);
    try {
      const bytes = Buffer.from(`${command}\n`);
      assert.equal(writeSync(this.control, bytes), bytes.length);
      const deadline = performance.now() + nativeProfileProtocol.commandTimeoutMs;
      const buffer = Buffer.alloc(128);
      while (true) {
        this.signal.throwIfAborted();
        assert(performance.now() < deadline, `perf ${command} acknowledgement timed out.`);
        let length = 0;
        try {
          length = readSync(this.acknowledgement, buffer);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
        }
        if (length) {
          const count = this.decoder.push(buffer.subarray(0, length));
          assert(count <= 1, "Unexpected extra perf acknowledgement.");
          if (count === 1) {
            receipt.acknowledgedMonotonicMs = monotonicMs();
            return;
          }
        }
        // stop can exit after writing its reply but before this reader is scheduled.
        // Drain the FIFO first; only then treat an exit without acknowledgement as failure.
        assert(this.child.exitCode === null, `perf exited before ${command} acknowledgement.`);
        await Bun.sleep(10);
      }
    } finally {
      this.commandPending = false;
    }
  }

  async enable() {
    await this.command("enable");
  }

  mark(name: "process-sample-start" | "process-sample-end") {
    this.marks.push({ name, monotonicMs: monotonicMs() });
  }

  async stop() {
    try {
      await this.command("disable");
      await this.command("stop");
      assert(this.child);
      const timer = setTimeout(() => this.child?.kill("SIGTERM"), 15_000);
      try {
        assert.equal(await this.child.exited, 0, "perf did not exit successfully after stop.");
      } finally {
        clearTimeout(timer);
      }
      const data = join(this.directory, "perf.data");
      assert(await this.makeDataReadable("stop-data-readability"), "perf wrote no data file.");
      assert((await stat(data)).size > 0, "perf wrote no data.");
      this.receipt.dataSha256 = await hashFile(data);
      this.receipt.captured = true;
      this.finished = true;
      await this.save();
    } catch (error) {
      this.receipt.failure = String(error);
      await this.save();
      throw error;
    } finally {
      this.closePipes();
    }
  }

  async analyze() {
    try {
      assert(this.finished, "Analyze only a stopped, flushed capture.");
      await this.identity();
      const symbols = await verifyNativeSymbols(`/proc/${this.pid}/exe`);
      await mkdir(this.cache, { recursive: true });
      const prefix = [this.perf, "--buildid-dir", this.cache];
      await this.run([...prefix, "buildid-cache", "--add", symbols.symbolFilePath], "symbol-cache");
      const data = join(this.directory, "perf.data");
      await this.run([...prefix, "buildid-list", "--with-hits", "--input", data], "buildids");
      const ids = await readFile(join(this.directory, "buildids.stdout.txt"), "utf8");
      assert(
        ids.includes(symbols.profileBuildId),
        "Profile does not contain the verified native build ID.",
      );
      await this.run(
        [...prefix, "script", "--input", data, "--show-lost-events", "--show-task-events", "--ns"],
        "script",
      );
      await this.run(
        [
          ...prefix,
          "script",
          "--input",
          data,
          "--hide-call-graph",
          "--fields",
          "comm,pid,tid,time,event,ip,sym,dso",
          "--ns",
        ],
        "samples",
      );
      await this.run(
        [
          ...prefix,
          "report",
          "--input",
          data,
          "--stdio",
          "--percent-limit",
          "0",
          "--sort",
          "comm,pid,dso,symbol",
          "--no-children",
        ],
        "report",
      );
      const sampleText = await readFile(join(this.directory, "samples.stdout.txt"), "utf8");
      const lines = sampleText.split("\n").filter((line) => line.trim() && !line.startsWith("#"));
      const samples = lines.map((line) => {
        const match = line.match(/^\s*(.*?)\s+(\d+)\/(\d+)\s+([\d.]+):\s+(\S+):\s+(.*)$/);
        assert(match, `Unparsed perf sample: ${line.slice(0, 200)}`);
        return {
          comm: match[1]!,
          pid: Number(match[2]),
          tid: Number(match[3]),
          time: match[4],
          event: match[5],
          detail: match[6]!,
        };
      });
      assert(samples.length > 0, "perf recorded no actual samples.");
      const unexpectedPids = [
        ...new Set(samples.filter((item) => item.pid !== this.pid).map((item) => item.pid)),
      ];
      const commandReceipt = (name: string) =>
        this.commands.find((item) => (item as { command: string }).command === name) as {
          sentMonotonicMs: number;
          acknowledgedMonotonicMs: number;
        };
      const enable = commandReceipt("enable");
      const disable = commandReceipt("disable");
      const sampleStart = this.marks.find(
        (item) => (item as { name: string }).name === "process-sample-start",
      ) as { monotonicMs: number };
      const sampleEnd = this.marks.find(
        (item) => (item as { name: string }).name === "process-sample-end",
      ) as { monotonicMs: number };
      assert(enable && disable && sampleStart && sampleEnd);
      assert(enable.acknowledgedMonotonicMs <= sampleStart.monotonicMs);
      assert(sampleEnd.monotonicMs <= disable.sentMonotonicMs);
      const outsideControlledWindow = samples.filter((item) => {
        const time = Number(item.time) * 1_000;
        return time < enable.sentMonotonicMs || time > disable.acknowledgedMonotonicMs;
      });
      const inProcessSampleWindow = samples.filter((item) => {
        const time = Number(item.time) * 1_000;
        return time >= sampleStart.monotonicMs && time <= sampleEnd.monotonicMs;
      }).length;
      const scriptText = await readFile(join(this.directory, "script.stdout.txt"), "utf8");
      const lostRecords = scriptText
        .split("\n")
        .filter((line) => /PERF_RECORD_LOST(?:_SAMPLES)?\b/.test(line));
      this.receipt.sampleAudit = {
        samples: samples.length,
        sampledTids: [...new Set(samples.map((item) => item.tid))],
        finalThreads: (await readdir(`/proc/${this.pid}/task`))
          .filter((name) => /^\d+$/.test(name))
          .map(Number),
        unexpectedPids,
        unknownSymbolOrDsoSamples: samples.filter((item) =>
          /\[unknown\]|\(unknown\)/.test(item.detail),
        ).length,
        unknownCountScope:
          "Explicit unknown markers only; raw output retains all unresolved addresses and frames.",
        inProcessSampleWindow,
        controlEdgeSamples: samples.length - inProcessSampleWindow - outsideControlledWindow.length,
        outsideControlledWindow: outsideControlledWindow.length,
        lostEventRecordCount: lostRecords.length,
        lostEventRecords: lostRecords.slice(0, 100),
        lostEventRecordListTruncated: lostRecords.length > 100,
        scope:
          "All recorded userspace samples; unknown frames and lost-event records remain in raw outputs.",
      };
      assert.equal(unexpectedPids.length, 0, "Unexpected process in own-TUI profile.");
      assert.equal(
        outsideControlledWindow.length,
        0,
        "Samples fall outside acknowledged perf control brackets.",
      );
      assert(
        inProcessSampleWindow > 0,
        "No native samples overlap the process measurement window.",
      );
      this.receipt.completed = true;
    } catch (error) {
      this.receipt.failure = String(error);
      throw error;
    } finally {
      await this.save();
    }
  }

  private closePipes() {
    if (this.control !== undefined) closeSync(this.control);
    if (this.acknowledgement !== undefined) closeSync(this.acknowledgement);
    this.control = undefined;
    this.acknowledgement = undefined;
  }

  private async makeDataReadable(logName: string) {
    const data = join(this.directory, "perf.data");
    let dataStat;
    try {
      dataStat = await lstat(data);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    assert(
      dataStat.isFile() && !dataStat.isSymbolicLink(),
      "Expected this capture's regular perf data file.",
    );
    if (this.privileged) await this.run(["sudo", "-n", "chmod", "0644", "--", data], logName);
    return true;
  }

  async cleanup() {
    this.closePipes();
    if (this.child && this.child.exitCode === null) {
      try {
        this.child.kill("SIGTERM");
      } catch (error) {
        this.receipt.cleanupSignalFailure = String(error);
        await this.save();
      }
      // The fixed external timeout is the final bound even for privileged capture.
      await this.child.exited;
    }
    // A failed/partial capture is evidence too. Adjust only the known regular
    // data file, after the bounded recorder has exited, without recursive chmod.
    try {
      await this.makeDataReadable("cleanup-data-readability");
    } catch (error) {
      this.receipt.cleanupDataFailure = String(error);
      await this.save();
      throw error;
    } finally {
      await rm(this.controlDirectory, { recursive: true, force: true });
    }
    captures.delete(this);
  }
}

export async function stopNativeProfiles() {
  const failures: unknown[] = [];
  for (const capture of captures) {
    try {
      await capture.cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, "Native profile cleanup was incomplete.");
}
