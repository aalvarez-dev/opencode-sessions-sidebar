/** Test-only native PTY relay. Forwards OpenCode's bytes unchanged to the actual Terminal window. */
import assert from "node:assert/strict";
import { readFile, rename, writeFile } from "node:fs/promises";
import { parseDesignClick } from "./terminal-design-input";

assert.equal(process.platform, "darwin");
assert.equal(Bun.version, "1.3.14");
assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
assert.equal(process.env.SIDEBAR_DESIGN, "true");
assert(
  process.stdin.isTTY && process.stdout.isTTY,
  "The relay must run inside its owned Terminal window.",
);
const executable = process.env.SIDEBAR_DESIGN_OPENCODE;
const exchange = process.env.SIDEBAR_DESIGN_RELAY_EXCHANGE;
assert(executable && exchange, "Missing isolated relay configuration.");
const dimensions = () => ({ columns: process.stdout.columns, rows: process.stdout.rows });
const initial = dimensions();
assert(initial.columns > 0 && initial.rows > 0);
const child = Bun.spawn([executable], {
  cwd: process.cwd(),
  env: process.env,
  terminal: {
    cols: initial.columns,
    rows: initial.rows,
    data(_terminal, data) {
      process.stdout.write(data);
    },
  },
});
assert(child.terminal);
let stopped = false;
let failed: unknown;
let lastId = 0;
let acceptedClicks = 0;
let reading = false;
let resolveStop: () => void = () => {};
const stop = new Promise<void>((resolve) => {
  resolveStop = resolve;
});
const finish = () => {
  stopped = true;
  resolveStop();
};
const fail = (error: unknown) => {
  failed = error;
  finish();
};
const relayInput = (data: Buffer) => {
  if (!stopped && child.exitCode === null) child.terminal!.write(data);
};
const resize = () => {
  const current = dimensions();
  if (!stopped && current.columns > 0 && current.rows > 0)
    child.terminal!.resize(current.columns, current.rows);
};
process.stdin.setRawMode(true);
process.stdin.on("data", relayInput);
process.on("SIGWINCH", resize);
process.on("SIGTERM", finish);
process.on("SIGINT", finish);
async function tick() {
  if (reading || stopped) return;
  reading = true;
  try {
    const raw = await readFile(`${exchange}.request.json`, "utf8").catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (!raw || stopped) return;
    const value = JSON.parse(raw);
    if (value?.id === lastId) return;
    const current = dimensions();
    const click = parseDesignClick(value, current.columns, current.rows, lastId);
    assert.equal(
      acceptedClicks,
      0,
      "The design scenario accepts at most one onboarding-close click.",
    );
    assert(child.exitCode === null);
    child.terminal!.write(
      `\u001b[<0;${click.column};${click.row}M\u001b[<0;${click.column};${click.row}m`,
    );
    lastId = click.id;
    acceptedClicks++;
    await writeFile(
      `${exchange}.response.tmp`,
      JSON.stringify({
        ok: true,
        input: "SGR mouse through the owned native PTY",
        ...click,
        ...current,
      }),
    );
    await rename(`${exchange}.response.tmp`, `${exchange}.response.json`);
  } finally {
    reading = false;
  }
}
const interval = setInterval(() => {
  void tick().catch(fail);
}, 25);
const deadline = setTimeout(
  () => fail(new Error("Native design relay exceeded its 210-second deadline.")),
  210_000,
);
try {
  await Promise.race([child.exited, stop]);
} finally {
  stopped = true;
  clearInterval(interval);
  clearTimeout(deadline);
  process.stdin.off("data", relayInput);
  process.off("SIGWINCH", resize);
  process.off("SIGTERM", finish);
  process.off("SIGINT", finish);
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([child.exited, Bun.sleep(1_000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
  child.terminal.close();
  process.stdin.setRawMode(false);
  process.stdin.pause();
}
if (failed) throw failed;
process.exitCode = child.exitCode ?? 0;
