/** Paired stock-TUI process comparison with the actual rendered sidebar, no inference. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { cpus, release, tmpdir, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import type { ResourceProbeResult } from "./sidebar-resource-probe";

assert.equal(process.platform, "linux", "This comparison requires Linux /proc and a POSIX PTY.");
assert.equal(Bun.version, "1.3.14", "Use pinned Bun 1.3.14.");
assert(process.env.OPENCODE_BIN, "Set OPENCODE_BIN to stock OpenCode 1.18.30.");
const executable = await realpath(process.env.OPENCODE_BIN);
const repository = resolve(import.meta.dir, "..");
const plugin = await realpath(process.env.SIDEBAR_PLUGIN_FILE ?? join(repository, "dist/tui.js"));
// Fixed before measurement; independent of the narrower headless and navigation budgets.
const budgets = { medianRssDeltaMiB: 64, medianCpuDeltaPoints: 1 };
const diagnostic = process.env.SIDEBAR_RESOURCE_DIAGNOSTIC === "true";
const sizes = diagnostic ? [250] : [25, 250];
const repetitions = diagnostic ? 1 : 3;
const settleMs = 2_000;
const observationMs = diagnostic ? 30_000 : 5_000;
const root = await mkdtemp(join(tmpdir(), "sidebar-rendered-resources-"));
const project = join(root, "project");
const seedConfig = join(root, "seed-config");
const seedData = join(root, "seed-data");
const children = new Set<ReturnType<typeof Bun.spawn>>();
const lifetime = new AbortController();
const watchdog = setTimeout(() => {
  lifetime.abort(new Error("Rendered resource comparison exceeded six minutes."));
  for (const child of children) child.kill("SIGKILL");
}, 360_000);

function environment(config: string, data: string, label: string) {
  return {
    PATH: process.env.PATH ?? "",
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    LANG: "C.UTF-8",
    HOME: join(root, "home"),
    OPENCODE_TEST_HOME: join(root, "home"),
    OPENCODE_TEST_MANAGED_CONFIG_DIR: join(root, "managed"),
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: data,
    XDG_CACHE_HOME: join(root, `${label}-cache`),
    XDG_STATE_HOME: join(root, `${label}-state`),
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    GIT_CONFIG_NOSYSTEM: "true",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
}

async function command(args: string[], cwd = repository) {
  const child = Bun.spawn(args, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    signal: lifetime.signal,
    env: environment(seedConfig, seedData, "seed"),
  });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  assert.equal(code, 0, err);
  return out.trim();
}

async function until(check: () => Promise<boolean>, message: string, timeout = 45_000) {
  const start = performance.now();
  while (!(await check())) {
    lifetime.signal.throwIfAborted();
    assert(performance.now() - start < timeout, message);
    await Bun.sleep(25);
  }
}

async function stop(child: ReturnType<typeof Bun.spawn>) {
  if (child.exitCode === null) child.kill("SIGKILL");
  await child.exited;
  child.terminal?.close();
  children.delete(child);
}

async function hashes() {
  const paths = ["scripts/benchmark-sidebar-runtime.ts", "scripts/sidebar-resource-probe.ts"];
  async function visit(directory: string) {
    for (const entry of await readdir(join(repository, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await visit(path);
      else if (/\.tsx?$/.test(path)) paths.push(path);
    }
  }
  await visit("src");
  const result: Record<string, string> = {};
  for (const path of paths.sort())
    result[path] = createHash("sha256")
      .update(await readFile(join(repository, path)))
      .digest("hex");
  result.runtimePlugin = createHash("sha256")
    .update(await readFile(plugin))
    .digest("hex");
  return result;
}

async function sample(pid: number, pageSize: number) {
  const [stat, status] = await Promise.all([
    readFile(`/proc/${pid}/stat`, "utf8"),
    readFile(`/proc/${pid}/status`, "utf8"),
  ]);
  const fields = stat
    .slice(stat.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/);
  const ticks = Number(fields[11]) + Number(fields[12]);
  const rssMiB = (Number(fields[21]) * pageSize) / 1024 ** 2;
  const switches =
    Number(status.match(/^voluntary_ctxt_switches:\s+(\d+)/m)?.[1]) +
    Number(status.match(/^nonvoluntary_ctxt_switches:\s+(\d+)/m)?.[1]);
  assert([ticks, rssMiB, switches].every(Number.isFinite), "Invalid process counters.");
  return { ticks, rssMiB, switches };
}

interface Measurement {
  sessions: number;
  repetition: number;
  enabled: boolean;
  bootToRenderedReadyMs: number;
  observationMs: number;
  cpuPercent: number;
  rssStartMiB: number;
  rssEndMiB: number;
  mainThreadContextSwitches: number;
  readyToObservationMs: number;
  trace?: {
    elapsedMs: number;
    intervalMs: number;
    cpuPercent: number | null;
    rssMiB: number;
    mainThreadContextSwitches: number;
  }[];
  probe: ResourceProbeResult;
}

const measurements: Measurement[] = [];
const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const report: Record<string, unknown> = {
  schema: 2,
  kind: diagnostic ? "diagnostic-time-series" : "acceptance-comparison",
  acceptanceEvaluated: !diagnostic,
  ...(diagnostic ? {} : { passed: false }),
  budgets,
  measurements,
};
const hostConfig = JSON.stringify({ autoupdate: false, share: "disabled", enabled_providers: [] });

try {
  await Promise.all([mkdir(project), mkdir(join(root, "home")), mkdir(join(root, "managed"))]);
  await mkdir(join(seedConfig, "opencode"), { recursive: true });
  await writeFile(join(seedConfig, "opencode", "opencode.json"), hostConfig);
  assert.equal(await command([executable, "--version"], project), "1.18.30");
  // A distinct synthetic Git root prevents inherited workspace identity/instructions.
  await command(
    ["git", "init", "--initial-branch=lab", `--template=${join(root, "managed")}`],
    project,
  );
  await command(
    [
      "git",
      "-c",
      "user.name=Synthetic resource fixture",
      "-c",
      "user.email=resource@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--allow-empty",
      "-m",
      "Synthetic fixture",
    ],
    project,
  );
  const [clockTicks, pageSize, baseCommit, sourceHashes] = await Promise.all([
    command(["getconf", "CLK_TCK"]).then(Number),
    command(["getconf", "PAGESIZE"]).then(Number),
    command(["git", "rev-parse", "HEAD"]),
    hashes(),
  ]);
  assert(clockTicks > 0 && pageSize > 0);
  report.source = {
    baseCommit,
    sha256: sourceHashes,
    pluginSource: process.env.SIDEBAR_PLUGIN_FILE ? "external packaged artifact" : "local build",
  };
  report.environment = {
    platform: process.platform,
    arch: process.arch,
    kernel: release(),
    cpuModel: cpus()[0]?.model,
    visibleLogicalCpus: cpus().length,
    visibleMemoryGiB: totalmem() / 1024 ** 3,
    bun: Bun.version,
    opencode: "1.18.30",
    terminal: "Bun POSIX PTY, xterm-256color, 140x40",
    sizes,
    repetitions,
    settleMs,
    observationMs,
    measurementProtocol: "finish-receipt-v1",
    diagnosticIntervalMs: diagnostic ? 1_000 : null,
    clockTicks,
    pageSize,
    icons: "ascii",
    density: "balanced",
    reducedMotion: false,
    extensions: [],
    cache: "Fresh copied data, per-treatment cache; warm OS filesystem cache is not flushed.",
  };
  const probePath = join(root, "observer.mjs");
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "sidebar-resource-probe.ts")],
    target: "bun",
    format: "esm",
  });
  assert(built.success && built.outputs[0], "Could not bundle resource observer.");
  await Bun.write(probePath, built.outputs[0]);
  let seeded = 0;
  let selectedSession: string | undefined;
  for (const size of sizes) {
    const server = Bun.spawn(
      [executable, "serve", "--pure", "--hostname", "127.0.0.1", "--port", "0"],
      {
        cwd: project,
        env: environment(seedConfig, seedData, "seed"),
        stdout: "pipe",
        stderr: "ignore",
      },
    );
    children.add(server);
    let baseUrl: string | undefined;
    const drain = (async () => {
      let output = "";
      for await (const bytes of server.stdout as ReadableStream<Uint8Array>) {
        output = (output + new TextDecoder().decode(bytes)).slice(-4096);
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
      const created = await client.session.create(
        { directory: project, title: `Synthetic resource session ${seeded + 1}` },
        { throwOnError: true, signal: lifetime.signal },
      );
      assert(created.data);
      selectedSession ??= created.data.id;
      seeded++;
    }
    await stop(server);
    await drain;
    assert(selectedSession);
    for (let repetition = 1; repetition <= repetitions; repetition++) {
      for (const enabled of repetition % 2 ? [false, true] : [true, false]) {
        const label = `${size}-${repetition}-${enabled ? "enabled" : "baseline"}`;
        const data = join(root, `${label}-data`);
        const config = join(root, `${label}-config`);
        const output = join(root, `${label}-result.json`);
        await cp(seedData, data, { recursive: true });
        await mkdir(join(config, "opencode"), { recursive: true });
        await writeFile(join(config, "opencode", "opencode.json"), hostConfig);
        await writeFile(
          join(config, "opencode", "tui.json"),
          JSON.stringify({
            plugin: [
              ...(enabled
                ? [
                    [
                      pathToFileURL(plugin).href,
                      {
                        hostId: "synthetic-resource-host",
                        storageDirectory: join(root, `${label}-organization`),
                        icons: "ascii",
                        density: "balanced",
                      },
                    ],
                  ]
                : []),
              pathToFileURL(probePath).href,
            ],
          }),
        );
        const boot = performance.now();
        let tail = "";
        const tui: ReturnType<typeof Bun.spawn> = Bun.spawn([executable], {
          cwd: project,
          env: {
            ...environment(config, data, label),
            SIDEBAR_RESOURCE_OUTPUT: output,
            SIDEBAR_RESOURCE_DIRECTORY: project,
            SIDEBAR_RESOURCE_SESSION: selectedSession,
            SIDEBAR_RESOURCE_ENABLED: String(enabled),
            SIDEBAR_RESOURCE_SESSIONS: String(size),
          },
          terminal: {
            cols: 140,
            rows: 40,
            data(terminal, bytes) {
              const text = new TextDecoder().decode(bytes);
              tail = (tail + text).slice(-4096);
              if (text.includes("\u001b]11;?"))
                terminal.write("\u001b]11;rgb:0000/0000/0000\u001b\\");
              if (text.includes("\u001b[6n")) terminal.write("\u001b[1;1R");
            },
          },
        });
        children.add(tui);
        await until(async () => {
          assert(tui.exitCode === null, `TUI exited before ready: ${tail}`);
          if (await Bun.file(output).exists()) {
            const failed = (await Bun.file(output).json()) as ResourceProbeResult;
            assert(failed.passed, failed.message ?? "Resource observer failed before readiness.");
          }
          return Bun.file(`${output}.ready`).exists();
        }, `TUI did not become ready (${label}).`);
        const bootToRenderedReadyMs = performance.now() - boot;
        const readyReceivedAt = performance.now();
        const ready = (await Bun.file(`${output}.ready`).json()) as {
          pid: number;
          procPid: number;
          measurementProtocol: string;
        };
        assert.equal(ready.pid, tui.pid);
        assert.equal(ready.measurementProtocol, "finish-receipt-v1");
        await Bun.sleep(settleMs);
        const started = performance.now();
        const before = await sample(ready.procPid, pageSize);
        let after = before;
        const trace: NonNullable<Measurement["trace"]> = [];
        if (diagnostic) {
          let previous = before;
          let previousAt = performance.now();
          trace.push({
            elapsedMs: previousAt - started,
            intervalMs: 0,
            cpuPercent: null,
            rssMiB: before.rssMiB,
            mainThreadContextSwitches: 0,
          });
          for (let index = 0; index < 30; index++) {
            lifetime.signal.throwIfAborted();
            await Bun.sleep(1_000);
            after = await sample(ready.procPid, pageSize);
            const now = performance.now();
            const intervalMs = now - previousAt;
            trace.push({
              elapsedMs: now - started,
              intervalMs,
              cpuPercent: (((after.ticks - previous.ticks) / clockTicks) * 100_000) / intervalMs,
              rssMiB: after.rssMiB,
              mainThreadContextSwitches: after.switches - previous.switches,
            });
            previous = after;
            previousAt = now;
          }
        } else {
          await Bun.sleep(observationMs);
          after = await sample(ready.procPid, pageSize);
        }
        const actualMs = performance.now() - started;
        assert(
          !(await Bun.file(`${output}.lifecycle-started`).exists()) &&
            !(await Bun.file(output).exists()),
          "Lifecycle work overlapped the idle sample; discard run.",
        );
        await writeFile(`${output}.measurement-finished.tmp`, "measurement-complete\n");
        await rename(`${output}.measurement-finished.tmp`, `${output}.measurement-finished`);
        await until(
          async () => {
            assert(tui.exitCode === null, "TUI exited before lifecycle checks.");
            return Bun.file(output).exists();
          },
          "Lifecycle checks did not finish.",
          60_000,
        );
        const probe = (await Bun.file(output).json()) as ResourceProbeResult;
        assert(probe.passed, probe.message ?? "Resource observer failed.");
        assert(
          probe.measurementAcknowledged,
          "Observer did not acknowledge measurement completion.",
        );
        const measurement: Measurement = {
          sessions: size,
          repetition,
          enabled,
          bootToRenderedReadyMs,
          observationMs: actualMs,
          cpuPercent: (((after.ticks - before.ticks) / clockTicks) * 100_000) / actualMs,
          rssStartMiB: before.rssMiB,
          rssEndMiB: after.rssMiB,
          mainThreadContextSwitches: after.switches - before.switches,
          readyToObservationMs: started - readyReceivedAt,
          ...(diagnostic ? { trace } : {}),
          probe,
        };
        measurements.push(measurement);
        console.log(JSON.stringify({ measurement }));
        await stop(tui);
        await rm(data, { recursive: true, force: true });
      }
    }
  }
  assert.deepEqual(
    await hashes(),
    sourceHashes,
    "Sources or runtime artifact changed while measuring.",
  );
  const results = sizes.map((sessions) => {
    const selected = measurements.filter((item) => item.sessions === sessions);
    const deltas = selected
      .filter((item) => item.enabled)
      .map((item) => {
        const baseline = selected.find(
          (other) => !other.enabled && other.repetition === item.repetition,
        );
        assert(baseline);
        return {
          repetition: item.repetition,
          rssMiB: item.rssEndMiB - baseline.rssEndMiB,
          cpuPoints: item.cpuPercent - baseline.cpuPercent,
        };
      });
    const medianRssDeltaMiB = median(deltas.map((delta) => delta.rssMiB));
    const medianCpuDeltaPoints = median(deltas.map((delta) => delta.cpuPoints));
    return {
      sessions,
      deltas,
      medianRssDeltaMiB,
      medianCpuDeltaPoints,
      ...(diagnostic
        ? {}
        : {
            passed:
              medianRssDeltaMiB <= budgets.medianRssDeltaMiB &&
              medianCpuDeltaPoints <= budgets.medianCpuDeltaPoints,
          }),
    };
  });
  report.results = results;
  if (!diagnostic) report.passed = results.every((result) => result.passed);
  report.completed = true;
  report.limitations = [
    diagnostic
      ? "Diagnostic only: one baseline/enabled pair at 250 sessions with per-second traces; no acceptance budgets evaluated or stabilization claimed."
      : "Three pairs per size on shared hardware; no confidence interval or long-running stability guarantee.",
    "The fixed two-second settle is not proof of steady state; examine resident-memory drift and CPU activity before interpreting idle overhead.",
    "TUI-process RSS and aggregate-thread CPU only; excludes subprocesses, GPU and browser/client terminal.",
    "Main-thread context switches are not timer/wakeup counts; lifecycle visibility does not prove zero retained heap/subscriptions.",
    "Idle synthetic sessions, no prompts or external inference; no event-burst, native font, remote transport or packaged-install claim.",
    "The existing 250ms navigation and 500ms component budgets remain independent and unchanged.",
  ];
  console.log(JSON.stringify({ kind: report.kind, results, passed: report.passed }));
  if (!diagnostic)
    assert(report.passed, "Predeclared rendered-sidebar idle resource budgets did not all pass.");
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  clearTimeout(watchdog);
  lifetime.abort();
  for (const child of children) await stop(child);
  try {
    if (process.env.SIDEBAR_RESOURCE_REPORT)
      await writeFile(
        resolve(process.env.SIDEBAR_RESOURCE_REPORT),
        `${JSON.stringify(report, null, 2)}\n`,
      );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
