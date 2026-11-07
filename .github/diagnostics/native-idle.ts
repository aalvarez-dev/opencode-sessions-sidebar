/** One native baseline/sidebar profile pair; never a resource acceptance gate. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { verifyNativeSymbols } from "./native-perf";

const targetCommit = "2df3d858d1491749288bb92f330230b5b6d327f3";
const targetBundle = "09ffee5a091ce92c470ca52f3f799be6d5d88d6e79110ee9e189430d0046eaed";
const driverRepository = resolve(import.meta.dir, "../..");
const output = resolve(process.env.SIDEBAR_NATIVE_OUTPUT ?? ".sidebar-lab/native-idle");
const prepareOnly = process.argv.includes("--prepare-only");
const digest = (contents: string | Buffer) => createHash("sha256").update(contents).digest("hex");
const summary: Record<string, unknown> = {
  schema: 1,
  kind: "native-idle-profile-diagnostic",
  acceptanceEvaluated: false,
  completed: false,
  preparedOnly: prepareOnly,
  targetCommit,
  targetBundle,
  protocol: {
    order: ["baseline", "sidebar-enabled"],
    sessions: 250,
    repetitions: 1,
    settleMs: 2_000,
    observationMs: 30_000,
    event: "cpu-clock:u",
    frequencyHz: 199,
    callGraph: "dwarf,16384",
    privilegeMode:
      process.env.SIDEBAR_NATIVE_PERF_SUDO === "true"
        ? "predeclared-isolated-runner-sudo"
        : "current-user",
    measurement:
      "Enable acknowledgement precedes process sampling; disable and stopped/flushed perf precede all lifecycle work.",
  },
  limitations: [
    "One diagnostic pair with profiler overhead and equally prepared dependencies is not resource acceptance or a performance improvement.",
    "Userspace sampling covers existing threads of this owned TUI. --no-inherit excludes future threads and subprocesses; unexpected sampled processes invalidate the receipt.",
    "Native symbols use separate debug info with the unchanged official runtime. JIT/generated code and stack frames can remain unresolved; a resolved leaf alone does not establish callers or allocation sites. Inline source expansion is disabled.",
    "CPU sampling does not establish allocation ownership, retained objects or the cause of every RSS change. Lost samples and unknown symbols remain visible.",
    "No forced GC, changed product behavior, new polling, altered budgets, kernel policy changes or fallback privilege escalation is allowed.",
  ],
};

async function save() {
  await writeFile(join(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
}

async function hashFile(path: string) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}

async function command(args: string[], cwd: string) {
  const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    assert.equal(code, 0, stderr);
    return stdout.trim();
  } finally {
    clearTimeout(timer);
  }
}

async function inventory(directory: string) {
  const files: Record<string, string> = {};
  async function visit(relative = "") {
    for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      assert(Object.keys(files).length < 20_000, "Dependency fixture exceeds the inventory bound.");
      if (entry.isDirectory()) await visit(path);
      else if (entry.isSymbolicLink())
        files[path] = `symlink:${await readlink(join(directory, path))}`;
      else files[path] = digest(await readFile(join(directory, path)));
    }
  }
  await visit();
  return files;
}

export function generateNativeHarness(
  source: string,
  target: string,
  dependencies: string,
  evidence: string,
) {
  let generated = source;
  function replace(before: string, after: string) {
    assert.equal(
      generated.split(before).length - 1,
      1,
      `Pinned harness anchor changed: ${before.slice(0, 100)}`,
    );
    generated = generated.replace(before, after);
  }
  replace(
    'import assert from "node:assert/strict";',
    'import assert from "node:assert/strict";\nimport { NativePerfCapture, stopNativeProfiles } from "./native-perf";',
  );
  replace(
    'const repository = resolve(import.meta.dir, "..");',
    `const repository = ${JSON.stringify(target)};\nconst dependencyFixture = ${JSON.stringify(dependencies)};\nconst evidenceDirectory = ${JSON.stringify(evidence)};`,
  );
  replace(
    'const plugin = await realpath(process.env.SIDEBAR_PLUGIN_FILE ?? join(repository, "dist/tui.js"));',
    'const plugin = await realpath(join(repository, "dist/tui.js"));',
  );
  replace(
    'const diagnostic = process.env.SIDEBAR_RESOURCE_DIAGNOSTIC === "true";',
    "const diagnostic = true;",
  );
  replace(
    'const delayed = process.env.SIDEBAR_RESOURCE_DELAYED === "true";',
    "const delayed = false;",
  );
  replace(
    "const lifetime = new AbortController();",
    'const lifetime = new AbortController();\nconst requestStop = () => lifetime.abort(new Error("Native diagnostic controller requested shutdown."));\nprocess.once("SIGTERM", requestStop);',
  );
  replace(
    "  return result;\n}\n\nasync function sample",
    `  for (const name of ["benchmark-sidebar-runtime.ts", "native-perf.ts", "sidebar-resource-probe.ts", "thread-cpu-diagnostic.ts", "process-memory-diagnostic.ts"])\n    result[\x60generatedHarness/\${name}\x60] = createHash("sha256").update(await readFile(join(import.meta.dir, name))).digest("hex");\n  return result;\n}\n\nasync function sample`,
  );
  replace(
    '  lifecycleStatus: "pending" | "passed" | "failed";',
    '  lifecycleStatus: "pending" | "passed" | "failed";\n  nativeProfile: string;',
  );
  replace(
    "const measurements: Measurement[] = [];",
    "const measurements: Measurement[] = [];\nconst diagnosticTails: Record<string, string> = {};",
  );
  replace(
    "  await Bun.write(probePath, built.outputs[0]);",
    '  await Bun.write(probePath, built.outputs[0]);\n  await Bun.write(join(import.meta.dir, "observer.mjs"), built.outputs[0]);',
  );
  replace(
    '        await writeFile(join(config, "opencode", "opencode.json"), hostConfig);',
    '        for (const name of ["package.json", "package-lock.json", "node_modules"])\n          await cp(join(dependencyFixture, name), join(config, "opencode", name), { recursive: true });\n        await writeFile(join(config, "opencode", "opencode.json"), hostConfig);',
  );
  replace(
    "              tail = (tail + text).slice(-4096);",
    "              tail = (tail + text).slice(-32768);\n              diagnosticTails[label] = tail;",
  );
  replace(
    "        await Bun.sleep(settleMs);",
    '        assert.equal(ready.procPid, tui.pid, "Native profiling requires a matching owned PID namespace.");\n        const nativeProfile = new NativePerfCapture(tui.pid, label, lifetime.signal);\n        await nativeProfile.prepare();\n        await cp(`${output}.ready`, join(evidenceDirectory, label, "ready.json"));\n        await Bun.sleep(settleMs);\n        await nativeProfile.enable();\n        nativeProfile.mark("process-sample-start");',
  );
  replace(
    "        const actualMs = (diagnosticFinishedAt ?? performance.now()) - started;",
    '        const actualMs = (diagnosticFinishedAt ?? performance.now()) - started;\n        nativeProfile.mark("process-sample-end");',
  );
  replace(
    '        await appendFile(`${output}.measurement-finished`, "measurement-complete\\n");',
    '        await nativeProfile.stop();\n        await appendFile(`${output}.measurement-finished`, "measurement-complete\\n");',
  );
  replace(
    '          lifecycleStatus: "pending",',
    '          lifecycleStatus: "pending",\n          nativeProfile: join(evidenceDirectory, label, "capture.json"),',
  );
  replace(
    "        console.log(JSON.stringify({ measurement }));",
    '        await cp(output, join(evidenceDirectory, label, "probe.json"));\n        await nativeProfile.analyze();\n        console.log(JSON.stringify({ measurement }));',
  );
  replace(
    '    diagnostic\n      ? "Diagnostic only: one baseline/enabled pair at 250 sessions with per-second traces; no acceptance budgets evaluated or stabilization claimed."',
    '    diagnostic\n      ? "Native profiling diagnostic only: one baseline/enabled pair at 250 sessions, prepared dependencies and per-second traces; no acceptance evaluated or stabilization claimed."',
  );
  replace(
    "  for (const child of children) await stop(child);",
    '  try { await stopNativeProfiles(); } catch (error) { report.nativeCleanupFailure = String(error); process.exitCode = 1; }\n  for (const child of children) await stop(child);\n  process.removeListener("SIGTERM", requestStop);\n  await writeFile(join(evidenceDirectory, "terminal-tails.json"), JSON.stringify(diagnosticTails, null, 2));',
  );
  replace(
    "    await rm(root, { recursive: true, force: true });",
    '    const receipts = join(evidenceDirectory, "temporary-receipts");\n    await mkdir(receipts, { recursive: true });\n    for (const name of await readdir(root))\n      if (/\\.(?:json|ready|lifecycle-started|measurement-finished)$/.test(name))\n        await cp(join(root, name), join(receipts, name));\n    await rm(root, { recursive: true, force: true });',
  );
  return generated;
}

async function main() {
  assert.equal(process.platform, "linux");
  assert.equal(process.arch, "x64");
  assert.equal(Bun.version, "1.3.14");
  await mkdir(output, { recursive: true });
  await save();
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let dependencyLink: string | undefined;
  try {
    assert(process.env.SIDEBAR_NATIVE_TARGET_REPO && process.env.SIDEBAR_NATIVE_DEPENDENCIES);
    assert(process.env.OPENCODE_BIN && process.env.PERF_BIN);
    assert(process.env.SIDEBAR_NATIVE_SYMBOL_FILE && process.env.SIDEBAR_NATIVE_SYMBOL_REPORT);
    assert([undefined, "false", "true"].includes(process.env.SIDEBAR_NATIVE_PERF_SUDO));
    const target = await realpath(process.env.SIDEBAR_NATIVE_TARGET_REPO);
    const dependencies = await realpath(process.env.SIDEBAR_NATIVE_DEPENDENCIES);
    assert.notEqual(target, driverRepository, "The measured target must be a separate checkout.");
    assert.equal(await command(["git", "rev-parse", "HEAD"], target), targetCommit);
    assert.equal(
      await command(["git", "status", "--porcelain"], target),
      "",
      "Target source is dirty.",
    );
    assert.equal(digest(await readFile(join(target, "dist/tui.js"))), targetBundle);
    const manifest = JSON.parse(await readFile(join(dependencies, "package.json"), "utf8"));
    assert.equal(manifest.dependencies?.["@opencode-ai/plugin"], "1.18.30");
    const installed = JSON.parse(
      await readFile(join(dependencies, "node_modules/@opencode-ai/plugin/package.json"), "utf8"),
    );
    assert.equal(installed.version, "1.18.30");
    assert((await lstat(join(dependencies, "package-lock.json"))).isFile());
    const dependencyInventory = await inventory(dependencies);
    await writeFile(
      join(output, "dependency-inventory.json"),
      JSON.stringify(dependencyInventory, null, 2) + "\n",
    );
    await cp(join(dependencies, "package.json"), join(output, "dependency-package.json"));
    await cp(join(dependencies, "package-lock.json"), join(output, "dependency-package-lock.json"));
    const symbolReceipt = await verifyNativeSymbols(process.env.OPENCODE_BIN);
    summary.symbolIdentity = symbolReceipt;
    const generated = join(output, "generated");
    await mkdir(generated, { recursive: true });
    await symlink(join(target, "node_modules"), join(generated, "node_modules"));
    dependencyLink = join(generated, "node_modules");
    const source = await readFile(join(target, "scripts/benchmark-sidebar-runtime.ts"), "utf8");
    const contents = generateNativeHarness(source, target, dependencies, output);
    const harness = join(generated, "benchmark-sidebar-runtime.ts");
    await writeFile(harness, contents);
    for (const name of [
      "sidebar-resource-probe.ts",
      "thread-cpu-diagnostic.ts",
      "process-memory-diagnostic.ts",
    ])
      await cp(join(target, "scripts", name), join(generated, name));
    await cp(join(import.meta.dir, "native-perf.ts"), join(generated, "native-perf.ts"));
    const diff = Bun.spawn(
      [
        "git",
        "diff",
        "--no-index",
        "--",
        join(target, "scripts/benchmark-sidebar-runtime.ts"),
        harness,
      ],
      {
        stdout: Bun.file(join(output, "generated-harness.patch")),
        stderr: Bun.file(join(output, "generated-harness-diff.stderr.txt")),
      },
    );
    assert([0, 1].includes(await diff.exited));
    const generatedHashes = Object.fromEntries(
      await Promise.all(
        [
          "benchmark-sidebar-runtime.ts",
          "native-perf.ts",
          "sidebar-resource-probe.ts",
          "thread-cpu-diagnostic.ts",
          "process-memory-diagnostic.ts",
        ].map(async (name) => [name, digest(await readFile(join(generated, name)))]),
      ),
    );
    assert.equal(
      generatedHashes["sidebar-resource-probe.ts"],
      digest(await readFile(join(target, "scripts/sidebar-resource-probe.ts"))),
    );
    summary.provenance = {
      driverCommit: await command(["git", "rev-parse", "HEAD"], driverRepository),
      driverSha256: digest(await readFile(import.meta.path)),
      targetCommit,
      targetBundle,
      originalHarnessSha256: digest(source),
      generatedHashes,
      dependencyInventorySha256: digest(JSON.stringify(dependencyInventory)),
      symbolReceiptSha256: digest(await readFile(process.env.SIDEBAR_NATIVE_SYMBOL_REPORT)),
      observerUnchanged: true,
    };
    summary.prepared = true;
    await save();
    if (prepareOnly) return;
    await writeFile(
      join(output, "run-started.json"),
      JSON.stringify({ startedAt: new Date().toISOString(), targetCommit, targetBundle }) + "\n",
      { flag: "wx" },
    );
    child = Bun.spawn([process.execPath, harness], {
      cwd: target,
      env: {
        ...process.env,
        SIDEBAR_NATIVE_OUTPUT: output,
        SIDEBAR_RESOURCE_REPORT: join(output, "resources.json"),
        SIDEBAR_RESOURCE_DIAGNOSTIC: "true",
        SIDEBAR_RESOURCE_DELAYED: "false",
      },
      stdout: Bun.file(join(output, "harness.stdout.txt")),
      stderr: Bun.file(join(output, "harness.stderr.txt")),
    });
    let forceStop: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => {
      summary.watchdogExpired = true;
      child?.kill("SIGTERM");
      forceStop = setTimeout(() => child?.kill("SIGKILL"), 150_000);
    }, 480_000);
    try {
      assert.equal(
        await child.exited,
        0,
        "Native diagnostic failed; retained output includes the blocker.",
      );
      assert(!summary.watchdogExpired, "Native diagnostic exceeded its outer deadline.");
    } finally {
      clearTimeout(timeout);
      if (forceStop) clearTimeout(forceStop);
    }
    const resources = JSON.parse(await readFile(join(output, "resources.json"), "utf8"));
    assert(resources.completed && resources.acceptanceEvaluated === false);
    assert.equal(resources.measurements.length, 2);
    assert.equal(resources.source.sha256.runtimePlugin, targetBundle);
    const captures = [];
    for (const measurement of resources.measurements) {
      assert.equal(measurement.sessions, 250);
      assert.equal(measurement.lifecycleStatus, "passed");
      assert(measurement.probe.passed && measurement.probe.measurementAcknowledged);
      const capture = JSON.parse(await readFile(measurement.nativeProfile, "utf8"));
      assert(capture.completed && capture.sampleAudit.samples > 0);
      assert.equal(capture.sampleAudit.unexpectedPids.length, 0);
      captures.push(capture);
    }
    assert.deepEqual(await inventory(dependencies), dependencyInventory);
    assert.equal(digest(await readFile(join(target, "dist/tui.js"))), targetBundle);
    summary.captures = captures;
    summary.completed = true;
  } catch (error) {
    summary.failure = error instanceof Error ? error.message : String(error);
    summary.blockedOrIncomplete = true;
    process.exitCode = 1;
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      const forceStop = setTimeout(() => child?.kill("SIGKILL"), 150_000);
      try {
        await child.exited;
      } finally {
        clearTimeout(forceStop);
      }
    }
    // Dependency trees are runtime inputs, not uploaded evidence. Remove only
    // this temporary symlink, never the target checkout or its dependencies.
    if (dependencyLink) await unlink(dependencyLink);
    await save();
  }
}

if (import.meta.main) await main();
