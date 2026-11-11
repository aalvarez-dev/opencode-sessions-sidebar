/**
 * Activation-attribution campaign driver; the original acceptance harness stays unchanged.
 *
 * It measures the FIRST delayed import of the built product and its FIRST activation inside an
 * already-started host process, paired against a symmetric control whose only difference is that it
 * imports nothing from `dist/` and never activates. Arms run sequentially and interleave order each
 * pair so drift does not align with the treatment. Nothing forces GC; `app.heap_snapshot` is never
 * invoked here. The paired difference-in-differences is computed offline by the analyzer.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { attributionCriteria } from "./lib/attribution-criteria";
import type { ArmRun, PairRun } from "./lib/memory-deltas";

const repository = resolve(import.meta.dir, "..");
const executable = await realpath(process.env.OPENCODE_BIN!);
const version = process.env.SIDEBAR_TEST_OPENCODE_VERSION ?? "1.18.30";
assert(["1.18.30", "1.19.3"].includes(version));
const output = resolve(process.env.SIDEBAR_ATTRIBUTION_DIR!);
await mkdir(output, { recursive: true });
const pairs = Number(process.env.SIDEBAR_ATTRIBUTION_PAIRS ?? attributionCriteria.pairs);
const idleMs = Number(
  process.env.SIDEBAR_ATTRIBUTION_IDLE_MS ?? attributionCriteria.windows.idleMs,
);
const eventCount = Number(process.env.SIDEBAR_ATTRIBUTION_EVENTS ?? 20);
const product = resolve(repository, "dist/tui.js");
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

const report: any = {
  completed: false,
  acceptanceEvaluated: false,
  productSha256: hash(await readFile(product)),
  hostBinarySha256: hash(await readFile(executable)),
  version,
  protocol: {
    pairs,
    sessions: attributionCriteria.sessions,
    warmupPairsDiscarded: attributionCriteria.warmupPairsDiscarded,
    idleMs,
    eventCount,
    interleaved: true,
    sequentialArms: true,
    forcedGC: false,
    retries: 0,
  },
  pairs: [] as PairRun[],
};
await writeFile(join(output, "summary.json"), JSON.stringify(report, null, 2), { flag: "wx" });
const root = await mkdtemp(join(tmpdir(), "sidebar-activation-attribution-"));
const project = join(root, "project");
const seedConfig = join(root, "seed-config");
const seedData = join(root, "seed-data");
const lifetime = new AbortController();
const children = new Set<ReturnType<typeof Bun.spawn>>();
const watchdog = setTimeout(() => {
  lifetime.abort();
  for (const child of children) child.kill("SIGKILL");
}, 3_600_000);

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

try {
  await Promise.all([mkdir(project), mkdir(join(root, "home")), mkdir(join(root, "managed"))]);
  await mkdir(join(seedConfig, "opencode"), { recursive: true });
  const hostConfig = JSON.stringify({
    autoupdate: false,
    share: "disabled",
    enabled_providers: [],
  });
  await writeFile(join(seedConfig, "opencode/opencode.json"), hostConfig);
  assert.equal(await command([executable, "--version"], project), version);
  await command(
    ["git", "init", "--initial-branch=lab", `--template=${join(root, "managed")}`],
    project,
  );
  await command(
    [
      "git",
      "-c",
      "user.name=Synthetic attribution",
      "-c",
      "user.email=attribution@example.invalid",
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
  const compiled: Record<string, string> = {};
  for (const name of ["subject", "observer"]) {
    const build = await Bun.build({
      entrypoints: [join(repository, `scripts/activation-attribution-${name}.ts`)],
      target: "bun",
      format: "esm",
    });
    assert(build.success && build.outputs[0]);
    compiled[name] = join(output, `${name}.mjs`);
    await Bun.write(compiled[name]!, build.outputs[0]!);
  }
  let seeded = 0;
  let selectedSession: string | undefined;
  {
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
      let text = "";
      for await (const bytes of server.stdout as ReadableStream<Uint8Array>) {
        text = (text + new TextDecoder().decode(bytes)).slice(-4096);
        baseUrl ??= text.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
      }
    })();
    await until(async () => {
      assert(server.exitCode === null, "Seed server exited.");
      return Boolean(baseUrl);
    }, "Seed server did not start.");
    assert(baseUrl);
    const client = createOpencodeClient({ baseUrl });
    while (seeded < attributionCriteria.sessions) {
      const created = await client.session.create(
        { directory: project, title: `Synthetic attribution session ${seeded + 1}` },
        { throwOnError: true, signal: lifetime.signal },
      );
      assert(created.data);
      selectedSession ??= created.data.id;
      seeded++;
    }
    await stop(server);
    await drain;
    assert(selectedSession);
  }

  async function runArm(pairIndex: number, arm: "product" | "control"): Promise<ArmRun> {
    const label = `${pairIndex}-${arm}`;
    const data = join(root, `${label}-data`);
    const config = join(root, `${label}-config`);
    await cp(seedData, data, { recursive: true });
    await mkdir(join(config, "opencode"), { recursive: true });
    await writeFile(join(config, "opencode/opencode.json"), hostConfig);
    await writeFile(
      join(config, "opencode/tui.json"),
      JSON.stringify({
        plugin: [
          [
            pathToFileURL(compiled.subject!).href,
            {
              hostId: "synthetic-attribution",
              storageDirectory: join(root, `${label}-organization`),
              icons: "ascii",
              density: "balanced",
            },
          ],
          pathToFileURL(compiled.observer!).href,
        ],
      }),
    );
    const resultFile = join(output, `${label}.json`);
    let terminalText = "";
    console.log(`START ${label}`);
    const child: ReturnType<typeof Bun.spawn> = Bun.spawn([executable], {
      cwd: project,
      env: {
        ...environment(config, data, label),
        SIDEBAR_ATTRIBUTION_ARM: arm,
        SIDEBAR_ATTRIBUTION_OUTPUT: resultFile,
        SIDEBAR_ATTRIBUTION_PRODUCT: pathToFileURL(product).href,
        SIDEBAR_ATTRIBUTION_DIRECTORY: project,
        SIDEBAR_ATTRIBUTION_SESSION: selectedSession!,
        SIDEBAR_ATTRIBUTION_IDLE_MS: String(idleMs),
        SIDEBAR_ATTRIBUTION_EVENTS: String(eventCount),
        SIDEBAR_TEST_OPENCODE_VERSION: version,
      },
      terminal: {
        cols: 140,
        rows: 40,
        data(terminal, bytes) {
          const text = new TextDecoder().decode(bytes);
          terminalText = (terminalText + text).slice(-2_000_000);
          if (text.includes("\u001b]11;?")) terminal.write("\u001b]11;rgb:0000/0000/0000\u001b\\");
          if (text.includes("\u001b[6n")) terminal.write("\u001b[1;1R");
        },
      },
    });
    children.add(child);
    try {
      await until(
        async () => {
          assert(child.exitCode === null, `Native host exited: ${terminalText.slice(-2000)}`);
          return Bun.file(resultFile).exists();
        },
        `Arm observer timed out: ${label}`,
        240_000,
      );
      const raw = JSON.parse(await readFile(resultFile, "utf8"));
      const result: ArmRun = {
        arm,
        completed: Boolean(raw.completed),
        snapshots: raw.snapshots ?? [],
        injectedEvents: Number(raw.injectedEvents ?? 0),
        deliveredEvents: Number(raw.deliveredEvents ?? 0),
        ...(raw.failure ? { failure: String(raw.failure) } : {}),
      };
      console.log(`FINISH ${label} completed=${result.completed}`);
      return result;
    } catch (error) {
      if (lifetime.signal.aborted) throw error;
      console.error(`FAIL ${label}: ${String(error)}`);
      return {
        arm,
        completed: false,
        snapshots: [],
        injectedEvents: 0,
        deliveredEvents: 0,
        failure: String(error),
      };
    } finally {
      await writeFile(join(output, `${label}.terminal.log`), terminalText);
      await stop(child);
    }
  }

  for (let index = 0; index < pairs; index++) {
    const order: ("product" | "control")[] =
      index % 2 === 0 ? ["product", "control"] : ["control", "product"];
    let productArm: ArmRun | undefined;
    let controlArm: ArmRun | undefined;
    for (const arm of order) {
      const result = await runArm(index, arm);
      if (arm === "product") productArm = result;
      else controlArm = result;
    }
    const pair: PairRun = { index, order, product: productArm!, control: controlArm! };
    report.pairs.push(pair);
    await writeFile(join(output, "summary.json"), JSON.stringify(report, null, 2));
  }
  assert.equal(hash(await readFile(product)), report.productSha256);
  report.completed = true;
} catch (error) {
  report.failure = String(error);
  throw error;
} finally {
  clearTimeout(watchdog);
  lifetime.abort();
  for (const child of children) await stop(child);
  await writeFile(join(output, "summary.json"), JSON.stringify(report, null, 2));
  await rm(root, { recursive: true, force: true });
}
