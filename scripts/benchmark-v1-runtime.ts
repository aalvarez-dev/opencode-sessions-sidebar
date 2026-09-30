/** Controlled headless-adapter comparison in an official TUI, not a sidebar rendering benchmark. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { cpus, release, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";

assert.equal(process.platform, "linux", "Process sampling requires Linux /proc and a POSIX PTY.");
const binary = process.env.OPENCODE_BIN;
assert(binary, "Set OPENCODE_BIN to an installed official OpenCode 1.18.30 executable.");
const executable = await realpath(binary);
const budgets = { activationP95Ms: 500, medianRssDeltaMiB: 32, medianCpuDeltaPoints: 1 };
const sizes = [25, 250];
const repetitions = 3;
const settleMs = 2_000;
const observationMs = 5_000;
const root = await mkdtemp(join(tmpdir(), "sidebar-v1-benchmark-"));
const project = join(root, "project");
const seedConfig = join(root, "seed-config");
const seedData = join(root, "seed-data");
const children = new Set<ReturnType<typeof Bun.spawn>>();
const lifecycle = new AbortController();
const watchdog = setTimeout(() => {
  lifecycle.abort(new Error("Runtime benchmark exceeded six minutes."));
  for (const child of children) child.kill("SIGKILL");
}, 360_000);

async function command(args: string[]) {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", signal: lifecycle.signal });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  assert.equal(code, 0, stderr);
  return stdout.trim();
}

async function until(check: () => Promise<boolean>, message: string, budget = 45_000) {
  const started = performance.now();
  while (!(await check())) {
    lifecycle.signal.throwIfAborted();
    assert(performance.now() - started < budget, message);
    await Bun.sleep(25);
  }
}

function environment(config: string, data: string, label: string) {
  return {
    PATH: process.env.PATH ?? "",
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: data,
    XDG_CACHE_HOME: join(root, `${label}-cache`),
    XDG_STATE_HOME: join(root, `${label}-state`),
    OPENCODE_TEST_HOME: join(root, "isolated-home"),
    OPENCODE_TEST_MANAGED_CONFIG_DIR: join(root, "isolated-managed-config"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
    OPENCODE_DISABLE_AUTOUPDATE: "true",
  };
}

async function stop(child: ReturnType<typeof Bun.spawn>) {
  child.kill("SIGKILL");
  await child.exited;
  child.terminal?.close();
  children.delete(child);
}

interface ProcessSample {
  ticks: number;
  rssMiB: number;
  voluntarySwitches: number;
  involuntarySwitches: number;
}

async function sample(pid: number, pageSize: number): Promise<ProcessSample> {
  const [stat, status] = await Promise.all([
    readFile(`/proc/${pid}/stat`, "utf8"),
    readFile(`/proc/${pid}/status`, "utf8"),
  ]);
  const fields = stat
    .slice(stat.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/);
  return {
    ticks: Number(fields[11]) + Number(fields[12]),
    rssMiB: (Number(fields[21]) * pageSize) / 1024 ** 2,
    // These are the main thread's switches, not timer wakeups or all worker-thread switches.
    voluntarySwitches: Number(status.match(/^voluntary_ctxt_switches:\s+(\d+)/m)?.[1]),
    involuntarySwitches: Number(status.match(/^nonvoluntary_ctxt_switches:\s+(\d+)/m)?.[1]),
  };
}

interface ProbeResult {
  passed: boolean;
  message?: string;
  activationMs: number[];
  idleStart: { reads: number; pending: number; eventHandlers: number; disposeHooks: number };
  idleEnd: ProbeResult["idleStart"];
  cycleCounters: ProbeResult["idleStart"][];
  finalCounters: ProbeResult["idleStart"];
}

interface Measurement {
  size: number;
  repetition: number;
  enabled: boolean;
  bootToProbeReadyMs: number;
  observationMs: number;
  cpuPercent: number;
  rssStartMiB: number;
  rssEndMiB: number;
  mainThreadContextSwitches: number;
  probe: ProbeResult;
}

const measurements: Measurement[] = [];
const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

try {
  await mkdir(project);
  await mkdir(join(seedConfig, "opencode"), { recursive: true });
  await writeFile(join(seedConfig, "opencode", "opencode.json"), "{}");
  const seedEnv = environment(seedConfig, seedData, "seed");
  const versionChild = Bun.spawn([executable, "--version"], {
    cwd: project,
    env: seedEnv,
    stdout: "pipe",
    stderr: "pipe",
    signal: lifecycle.signal,
  });
  assert.equal((await new Response(versionChild.stdout).text()).trim(), "1.18.30");
  assert.equal(await versionChild.exited, 0);
  const [clockTicks, pageSize, commit, gitStatus] = await Promise.all([
    command(["getconf", "CLK_TCK"]).then(Number),
    command(["getconf", "PAGESIZE"]).then(Number),
    command(["git", "rev-parse", "HEAD"]),
    command(["git", "status", "--porcelain"]),
  ]);
  const harnessHash = createHash("sha256");
  for (const path of [
    "benchmark-v1-runtime.ts",
    "v1-benchmark-probe.ts",
    "../src/adapters/opencode-v1/adapter.ts",
    "../src/adapters/opencode-v1/types.ts",
  ]) {
    harnessHash
      .update(path)
      .update("\0")
      .update(await readFile(join(import.meta.dir, path)));
  }
  const metadata = {
    platform: process.platform,
    arch: process.arch,
    kernel: release(),
    cpuModel: cpus()[0]?.model,
    logicalCpus: cpus().length,
    memoryGiB: totalmem() / 1024 ** 3,
    bun: Bun.version,
    opencode: "1.18.30",
    pluginSdk: "1.18.30",
    commit,
    workingTreeDirty: gitStatus.length > 0,
    harnessAndAdapterSha256: harnessHash.digest("hex"),
    terminal: "Bun POSIX PTY, xterm-256color, 140 columns × 40 rows",
    cache:
      "New TUI processes and copied seed data per treatment; OS filesystem cache is not flushed.",
    scope:
      "TUI process RSS and aggregate thread CPU only; subprocesses excluded. Common probe in both treatments.",
    sizes,
    repetitions,
    settleMs,
    observationMs,
    clockTicks,
    pageSize,
    budgets,
  };
  console.log(JSON.stringify({ environment: metadata }));

  const probePath = join(root, "probe.mjs");
  const adapterPath = join(root, "adapter.mjs");
  for (const [entrypoint, destination] of [
    [join(import.meta.dir, "v1-benchmark-probe.ts"), probePath],
    [join(import.meta.dir, "../src/adapters/opencode-v1/index.ts"), adapterPath],
  ]) {
    assert(entrypoint && destination);
    const build = await Bun.build({ entrypoints: [entrypoint], target: "bun", format: "esm" });
    assert(build.success && build.outputs[0], "Could not bundle the isolated benchmark.");
    await Bun.write(destination, build.outputs[0]);
  }

  let seeded = 0;
  for (const size of sizes) {
    const server = Bun.spawn(
      [executable, "serve", "--pure", "--hostname", "127.0.0.1", "--port", "0"],
      {
        cwd: project,
        env: seedEnv,
        stdout: "pipe",
        stderr: "ignore",
      },
    );
    children.add(server);
    let baseUrl: string | undefined;
    assert(server.stdout && typeof server.stdout !== "number");
    const drain = (async () => {
      let output = "";
      for await (const data of server.stdout as ReadableStream<Uint8Array>) {
        output = (output + new TextDecoder().decode(data)).slice(-4096);
        baseUrl ??= output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
      }
    })();
    await until(async () => {
      assert(server.exitCode === null, "Seed server exited.");
      return Boolean(baseUrl);
    }, "Seed server did not start.");
    assert(baseUrl);
    const client = createOpencodeClient({ baseUrl });
    while (seeded < size) {
      const result = await client.session.create(
        { directory: project, title: `Synthetic benchmark session ${seeded + 1}` },
        { signal: lifecycle.signal, throwOnError: true },
      );
      assert(result.data);
      seeded++;
    }
    await stop(server);
    await drain;

    for (let repetition = 1; repetition <= repetitions; repetition++) {
      const treatments = repetition % 2 === 1 ? [false, true] : [true, false];
      for (const enabled of treatments) {
        const label = `${size}-${repetition}-${enabled ? "enabled" : "baseline"}`;
        const data = join(root, `${label}-data`);
        const config = join(root, `${label}-config`);
        await cp(seedData, data, { recursive: true });
        await mkdir(join(config, "opencode"), { recursive: true });
        await writeFile(join(config, "opencode", "opencode.json"), "{}");
        await writeFile(
          join(config, "opencode", "tui.json"),
          JSON.stringify({ plugin: [pathToFileURL(probePath).href] }),
        );
        const output = join(root, `${label}-result.json`);
        const boot = performance.now();
        const tui = Bun.spawn([executable], {
          cwd: project,
          env: {
            ...environment(config, data, label),
            TERM: "xterm-256color",
            LANG: "C.UTF-8",
            SIDEBAR_BENCHMARK_DIRECTORY: project,
            SIDEBAR_BENCHMARK_OUTPUT: output,
            SIDEBAR_BENCHMARK_MODULE: pathToFileURL(adapterPath).href,
            SIDEBAR_BENCHMARK_ENABLED: String(enabled),
            SIDEBAR_BENCHMARK_SESSIONS: String(size),
          },
          terminal: {
            cols: 140,
            rows: 40,
            data(terminal, data) {
              const text = new TextDecoder().decode(data);
              if (text.includes("\u001b]11;?"))
                terminal.write("\u001b]11;rgb:0000/0000/0000\u001b\\");
              if (text.includes("\u001b[6n")) terminal.write("\u001b[1;1R");
            },
          },
        });
        children.add(tui);
        await until(async () => {
          assert(tui.exitCode === null, "Stock TUI exited before the probe was ready.");
          if (await Bun.file(output).exists()) {
            const failed = (await Bun.file(output).json()) as ProbeResult;
            assert(failed.passed, failed.message ?? "Stock TUI probe failed.");
          }
          return Bun.file(`${output}.ready`).exists();
        }, "Stock TUI benchmark probe did not become ready.");
        const bootToProbeReadyMs = performance.now() - boot;
        const ready = (await Bun.file(`${output}.ready`).json()) as {
          pid: number;
          procPid: number;
        };
        assert.equal(ready.pid, tui.pid, "Probe PID does not match the spawned TUI.");
        await Bun.sleep(settleMs);
        const started = performance.now();
        const before = await sample(ready.procPid, pageSize);
        await Bun.sleep(observationMs);
        const after = await sample(ready.procPid, pageSize);
        const actualMs = performance.now() - started;
        assert(
          !(await Bun.file(output).exists()),
          "Probe completed before the idle sample ended; discard this run.",
        );
        await until(
          async () => {
            assert(tui.exitCode === null, "Stock TUI exited before lifecycle checks completed.");
            return Bun.file(output).exists();
          },
          "Stock TUI lifecycle checks did not finish.",
          20_000,
        );
        const probe = (await Bun.file(output).json()) as ProbeResult;
        assert(probe.passed, probe.message ?? "Stock TUI probe failed.");
        const measurement: Measurement = {
          size,
          repetition,
          enabled,
          bootToProbeReadyMs,
          observationMs: actualMs,
          cpuPercent: (((after.ticks - before.ticks) / clockTicks) * 100_000) / actualMs,
          rssStartMiB: before.rssMiB,
          rssEndMiB: after.rssMiB,
          mainThreadContextSwitches:
            after.voluntarySwitches +
            after.involuntarySwitches -
            before.voluntarySwitches -
            before.involuntarySwitches,
          probe,
        };
        measurements.push(measurement);
        console.log(JSON.stringify({ measurement }));
        await stop(tui);
        await rm(data, { recursive: true, force: true });
      }
    }
  }

  const results = sizes.map((size) => {
    const selected = measurements.filter((measurement) => measurement.size === size);
    const enabled = selected.filter((measurement) => measurement.enabled);
    const deltas = enabled.map((measurement) => {
      const baseline = selected.find(
        (item) => !item.enabled && item.repetition === measurement.repetition,
      );
      assert(baseline);
      return {
        rssMiB: measurement.rssEndMiB - baseline.rssEndMiB,
        cpuPoints: measurement.cpuPercent - baseline.cpuPercent,
      };
    });
    // With only three fresh activations, nearest-rank p95 equals the observed maximum.
    const activationP95Ms = Math.max(...enabled.map((item) => item.probe.activationMs[0]!));
    const result = {
      size,
      activationSamples: enabled.length,
      activationP95Ms,
      repeatedActivationMs: enabled.flatMap((item) => item.probe.activationMs.slice(1)),
      medianRssDeltaMiB: median(deltas.map((item) => item.rssMiB)),
      medianCpuDeltaPoints: median(deltas.map((item) => item.cpuPoints)),
      deltas,
    };
    return {
      ...result,
      passed:
        result.activationP95Ms <= budgets.activationP95Ms &&
        result.medianRssDeltaMiB <= budgets.medianRssDeltaMiB &&
        result.medianCpuDeltaPoints <= budgets.medianCpuDeltaPoints,
    };
  });
  console.log(
    JSON.stringify({
      results,
      caveats:
        "Three pairs per size, not a confidence interval; warm OS cache, no model inference, no sidebar rendering/input latency, no process-wide timer count or subprocess overhead.",
    }),
  );
  assert(
    results.every((result) => result.passed),
    "Predeclared headless-adapter runtime budgets did not all pass.",
  );
} finally {
  clearTimeout(watchdog);
  lifecycle.abort();
  for (const child of children) await stop(child);
  await rm(root, { recursive: true, force: true });
}
