/** Native child attention remains visible with completion and collapsed groups in stock TUI. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const expectedVersion = "1.18.30";
assert(process.env.OPENCODE_BIN, "Set OPENCODE_BIN to stock OpenCode 1.18.30.");
assert(process.platform !== "win32", "The rendered attention smoke requires a POSIX PTY.");
const executable = await realpath(process.env.OPENCODE_BIN);
const root = await mkdtemp(join(tmpdir(), "sidebar-ui-attention-"));
const directory = join(root, "project");
const config = join(root, "config");
const storageDirectory = join(root, "sidebar-state");
const exchange = join(root, "exchange");
const lifetime = new AbortController();
let child: ReturnType<typeof Bun.spawn> | undefined;
let fixture: ReturnType<typeof Bun.serve> | undefined;
let providerError: unknown;
let providerRequests = 0;
let requestId = 0;
let outputTail = "";
const deadline = setTimeout(() => {
  lifetime.abort(new Error("Rendered attention smoke exceeded 90 seconds."));
  child?.kill("SIGKILL");
}, 90_000);

type Span = { text: string; width: number; fg: number[]; bg: number[]; attributes: number };
type Snapshot = {
  parentId: string;
  childId: string;
  promptFinished: boolean;
  events: string[];
  dialogDepth: number;
  questions: { sessionID: string }[];
  permissions: { sessionID: string }[];
  statuses: Record<string, { type: string }>;
  organization: {
    completionStates: { sessionKey: string; done: boolean }[];
    pins: string[];
  } | null;
  frame: { width: number; height: number; frameId: number; lines: Span[][] };
};
const frames: { name: string; frame: Snapshot["frame"] }[] = [];
const repository = resolve(import.meta.dir, "..");
async function artifactHashes() {
  const paths = [
    "src/tui.tsx",
    "src/ui/controller.ts",
    "src/ui/model.ts",
    "src/ui/view.tsx",
    "scripts/sidebar-attention-probe.ts",
    "scripts/smoke-sidebar-attention.ts",
    "dist/tui.js",
  ];
  return Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => [
        path,
        createHash("sha256")
          .update(await readFile(join(repository, path)))
          .digest("hex"),
      ]),
    ),
  );
}

async function pause(ms = 20) {
  lifetime.signal.throwIfAborted();
  if (providerError) throw providerError;
  await Bun.sleep(ms);
}
async function request<T>(type: string, fields: object = {}): Promise<T> {
  const id = ++requestId;
  await writeFile(`${exchange}.request.tmp`, JSON.stringify({ id, type, ...fields }));
  await rename(`${exchange}.request.tmp`, `${exchange}.request.json`);
  const started = performance.now();
  for (;;) {
    lifetime.signal.throwIfAborted();
    if (providerError) throw providerError;
    assert(child?.exitCode === null, `Stock TUI exited: ${outputTail}`);
    const raw = await readFile(`${exchange}.response.json`, "utf8").catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (raw) {
      const response = JSON.parse(raw) as { id: number; ok: boolean; error?: string; result: T };
      if (response.id === id) {
        assert(response.ok, response.error ?? "Observer request failed.");
        return response.result;
      }
    }
    assert(performance.now() - started < 20_000, `Request ${type} timed out: ${outputTail}`);
    await pause(10);
  }
}
function lines(snapshot: Snapshot) {
  return snapshot.frame.lines.map((line) => line.map((span) => span.text).join(""));
}
function text(snapshot: Snapshot) {
  return lines(snapshot).join("\n");
}
async function until(check: (value: Snapshot) => boolean, description: string, budget = 5_000) {
  const started = performance.now();
  let last: Snapshot | undefined;
  do {
    last = await request<Snapshot>("snapshot");
    if (check(last)) return last;
    await pause();
  } while (performance.now() - started < budget);
  throw new Error(`${description}\n${last ? text(last) : outputTail}`);
}
function input(sequence: string) {
  assert(child?.terminal);
  child.terminal.write(sequence);
}
async function click(label: string) {
  const snapshot = await request<Snapshot>("snapshot");
  for (const [row, line] of lines(snapshot).entries()) {
    const column = line.indexOf(label);
    if (column < 0) continue;
    const x = column + 2;
    const y = row + 1;
    input(`\u001b[<0;${x};${y}M\u001b[<0;${x};${y}m`);
    return;
  }
  throw new Error(`Missing mouse label ${label}.\n${text(snapshot)}`);
}
async function action(label: string) {
  await request("command", { command: "sessions-sidebar.browse" });
  await until((snapshot) => snapshot.dialogDepth > 0, "Browse dialog missing.");
  input("Synthetic attention parent");
  await until(
    (snapshot) => text(snapshot).includes("Synthetic attention parent"),
    "Parent missing from browse.",
  );
  input("\r");
  await until((snapshot) => text(snapshot).includes("Open session"), "Session actions missing.");
  input(label);
  await until((snapshot) => text(snapshot).includes(label), `Missing action ${label}.`);
  input("\r");
  await until((snapshot) => snapshot.dialogDepth === 0, "Action did not close dialog.");
}
function groupText(snapshot: Snapshot, title: string, next: string) {
  const rows = lines(snapshot);
  const index = rows.findIndex((line) => line.includes(title));
  assert(index >= 0, `Missing group ${title}.`);
  const column = Math.max(0, rows[index]!.indexOf(title) - 2);
  const end = rows.findIndex((line, position) => position > index && line.includes(next));
  return rows
    .slice(index, end < 0 ? undefined : end)
    .map((line) => line.slice(column))
    .join("\n");
}
function assertVisible(snapshot: Snapshot, attention: "questions" | "permissions") {
  assert.equal(snapshot.statuses[snapshot.childId]?.type, "busy");
  assert(
    snapshot.organization?.completionStates.some(
      (state) => state.done && JSON.parse(state.sessionKey)[2] === snapshot.parentId,
    ),
  );
  const pinned = groupText(snapshot, "Pinned (", "Later (");
  const collapsed = groupText(snapshot, "All sessions (", "Select a session");
  assert(pinned.includes("[x]"), "Marked parent lost its visual completion mark.");
  assert(
    pinned.includes("busy 1") && pinned.includes(`${attention} 1`),
    "Marked parent hides descendant activity/attention.",
  );
  assert(collapsed.includes("+ All sessions (3)"), "All sessions must stay collapsed.");
  assert(
    collapsed.includes("busy 1") && collapsed.includes(`${attention} 1`),
    "Collapsed group hides attention.",
  );
  assert(
    !collapsed.includes("Synthetic attention child"),
    "Collapsed group unexpectedly expanded.",
  );
}
async function capture(name: string, snapshot: Snapshot) {
  const frame = JSON.parse(
    JSON.stringify(snapshot.frame).replaceAll(root, "/synthetic"),
  ) as Snapshot["frame"];
  frames.push({ name, frame });
  if (process.env.SIDEBAR_ATTENTION_FRAMES)
    await writeFile(resolve(process.env.SIDEBAR_ATTENTION_FRAMES), JSON.stringify(frames));
}

type ChatBody = {
  model: string;
  stream?: boolean;
  messages: { role: string; content?: unknown }[];
  tools?: { function: { name: string } }[];
};
function startFixture() {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      try {
        assert.equal(request.method, "POST");
        assert.equal(new URL(request.url).pathname, "/v1/chat/completions");
        const body = (await request.json()) as ChatBody;
        assert.equal(body.model, "synthetic");
        assert.equal(body.stream, true);
        providerRequests++;
        assert(providerRequests <= 3, "Unexpected extra fixture provider requests.");
        const replies = body.messages.filter((message) => message.role === "tool").length;
        const tool = replies === 0 ? "question" : replies === 1 ? "bash" : undefined;
        if (tool)
          assert(
            body.tools?.some((entry) => entry.function.name === tool),
            `Missing native ${tool} tool.`,
          );
        const args =
          tool === "question"
            ? {
                questions: [
                  {
                    header: "Synthetic",
                    question: "Choose the synthetic option.",
                    options: [
                      { label: "Continue", description: "Continue the isolated runtime probe." },
                    ],
                    custom: false,
                  },
                ],
              }
            : {
                command: "printf 'synthetic-probe'",
                description: "Synthetic runtime attention probe",
              };
        const delta = tool
          ? {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: `fixture_call_${replies}`,
                  type: "function",
                  function: { name: tool, arguments: JSON.stringify(args) },
                },
              ],
            }
          : { role: "assistant", content: "Synthetic probe complete." };
        const chunk = (content: object) =>
          `data: ${JSON.stringify({ id: `fixture_${providerRequests}`, object: "chat.completion.chunk", created: 0, model: "synthetic", ...content })}\n\n`;
        return new Response(
          chunk({ choices: [{ index: 0, delta, finish_reason: null }] }) +
            chunk({
              choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }) +
            "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        );
      } catch (error) {
        providerError = error;
        return new Response("Invalid synthetic provider request", { status: 500 });
      }
    },
  });
}

try {
  const measuredHashes = await artifactHashes();
  const git = Bun.spawn(["git", "rev-parse", "HEAD"], {
    cwd: repository,
    stdout: "pipe",
    stderr: "pipe",
  });
  const baseGitRevision = (await new Response(git.stdout).text()).trim();
  assert.equal(await git.exited, 0);
  if (process.platform === "darwin") {
    for (const path of [
      "/Library/Managed Preferences/ai.opencode.managed.plist",
      join("/Library/Managed Preferences", userInfo().username, "ai.opencode.managed.plist"),
    ]) {
      const present = await lstat(path).then(
        () => true,
        (error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        },
      );
      assert(!present, "Use an unmanaged host for this isolated probe.");
    }
  }
  fixture = startFixture();
  await Promise.all([
    mkdir(directory),
    mkdir(join(root, "home")),
    mkdir(join(root, "managed")),
    mkdir(join(config, "opencode"), { recursive: true }),
  ]);
  await writeFile(
    join(config, "opencode", "opencode.json"),
    JSON.stringify({
      model: "synthetic/synthetic",
      small_model: "synthetic/synthetic",
      enabled_providers: ["synthetic"],
      autoupdate: false,
      share: "disabled",
      provider: {
        synthetic: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: `${fixture.url.origin}/v1`, apiKey: "synthetic-not-a-secret" },
          models: {
            synthetic: {
              name: "Synthetic fixture",
              tool_call: true,
              limit: { context: 32000, output: 1024 },
            },
          },
        },
      },
      permission: { "*": "allow", bash: "ask" },
      compaction: { auto: false, prune: false },
    }),
  );
  const observer = join(root, "attention-probe.mjs");
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "sidebar-attention-probe.ts")],
    target: "bun",
    format: "esm",
  });
  assert(built.success && built.outputs[0]);
  await Bun.write(observer, built.outputs[0]);
  const plugin = resolve(import.meta.dir, "../dist/tui.js");
  assert(await Bun.file(plugin).exists(), "Build the TUI entrypoint before this smoke.");
  await writeFile(
    join(config, "opencode", "tui.json"),
    JSON.stringify({
      plugin: [
        [
          pathToFileURL(plugin).href,
          {
            hostId: "synthetic-sidebar-attention",
            storageDirectory,
            icons: "ascii",
            density: "balanced",
          },
        ],
        pathToFileURL(observer).href,
      ],
    }),
  );
  const env = {
    PATH: process.env.PATH ?? "",
    OPENCODE_TEST_HOME: join(root, "home"),
    OPENCODE_TEST_MANAGED_CONFIG_DIR: join(root, "managed"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    TERM: "xterm-256color",
    LANG: "C.UTF-8",
    SIDEBAR_ATTENTION_EXCHANGE: exchange,
    SIDEBAR_ATTENTION_DIRECTORY: directory,
    SIDEBAR_ATTENTION_STORAGE: storageDirectory,
  };
  const version = Bun.spawn([executable, "--version"], {
    cwd: directory,
    env,
    stdout: "pipe",
    stderr: "pipe",
    signal: lifetime.signal,
  });
  assert.equal((await new Response(version.stdout).text()).trim(), expectedVersion);
  assert.equal(await version.exited, 0);
  child = Bun.spawn([executable], {
    cwd: directory,
    env,
    terminal: {
      cols: 140,
      rows: 40,
      data(terminal, data) {
        const output = new TextDecoder().decode(data);
        outputTail = (outputTail + output).slice(-12_000);
        if (output.includes("\u001b]11;?")) terminal.write("\u001b]11;rgb:0000/0000/0000\u001b\\");
        if (output.includes("\u001b[6n")) terminal.write("\u001b[1;1R");
      },
    },
  });
  const started = performance.now();
  while (!(await Bun.file(`${exchange}.ready.json`).exists())) {
    assert(child.exitCode === null, `Stock TUI exited loading plugins: ${outputTail}`);
    assert(performance.now() - started < 45_000, `Observer did not start: ${outputTail}`);
    await pause();
  }
  await request("seed");
  await until(
    (snapshot) => text(snapshot).includes("All sessions (3)"),
    "Sidebar missing native sessions.",
  );
  await action("Mark completed");
  await action("Pin");
  await until((snapshot) => text(snapshot).includes("Pinned (1)"), "Pin did not render.");
  await click("All sessions (3)");
  await until(
    (snapshot) => text(snapshot).includes("+ All sessions (3)"),
    "Group did not collapse from mouse.",
  );
  await request("start");
  const question = await until(
    (snapshot) =>
      snapshot.questions.length === 1 &&
      groupText(snapshot, "Pinned (", "Later (").includes("questions 1") &&
      groupText(snapshot, "All sessions (", "Select a session").includes("questions 1"),
    "Native question did not reach marked/collapsed sidebar.",
    25_000,
  );
  assert.equal(question.questions[0]?.sessionID, question.childId);
  assertVisible(question, "questions");
  await capture("marked-parent-collapsed-question", question);
  assert(child.terminal);
  child.terminal.resize(88, 24);
  await until((snapshot) => snapshot.frame.width === 88, "Narrow resize missing.");
  await request("command", { command: "sessions-sidebar.browse" });
  await until((snapshot) => snapshot.dialogDepth > 0, "Narrow browse dialog missing.");
  input("Synthetic attention parent");
  const narrow = await until(
    (snapshot) => text(snapshot).includes("[x]") && text(snapshot).includes("ask1"),
    "Narrow browser must show both completion and question footer.",
  );
  await capture("narrow-marked-parent-question", narrow);
  input("\r");
  await until(
    (snapshot) =>
      text(snapshot).includes("Open session") &&
      text(snapshot).includes("busy 1") &&
      text(snapshot).includes("questions 1"),
    "Narrow session menu must retain full activity and attention labels.",
  );
  input("\u001b");
  await until((snapshot) => snapshot.dialogDepth === 0, "Narrow menu did not close.");
  child.terminal.resize(140, 40);
  const wide = await until(
    (snapshot) => snapshot.frame.width === 140 && text(snapshot).includes("+ All sessions (3)"),
    "Wide collapsed group did not return.",
  );
  assertVisible(wide, "questions");
  await request("reply-question");
  const permission = await until(
    (snapshot) =>
      snapshot.permissions.length === 1 &&
      groupText(snapshot, "Pinned (", "Later (").includes("permissions 1") &&
      groupText(snapshot, "All sessions (", "Select a session").includes("permissions 1"),
    "Native permission did not reach marked/collapsed sidebar.",
  );
  assert.equal(permission.permissions[0]?.sessionID, permission.childId);
  assert.equal(permission.questions.length, 0);
  assertVisible(permission, "permissions");
  await capture("marked-parent-collapsed-permission", permission);
  await request("reply-permission");
  const idle = await until(
    (snapshot) =>
      snapshot.promptFinished &&
      snapshot.questions.length === 0 &&
      snapshot.permissions.length === 0 &&
      !text(snapshot).includes("busy 1") &&
      !text(snapshot).includes("permissions 1"),
    "Resolved attention did not repaint.",
  );
  assert(
    idle.organization?.completionStates.some(
      (state) => state.done && JSON.parse(state.sessionKey)[2] === idle.parentId,
    ),
  );
  assert(groupText(idle, "Pinned (", "Later (").includes("[x]"));
  for (const type of [
    "question.asked",
    "question.replied",
    "permission.asked",
    "permission.replied",
  ])
    assert(idle.events.includes(type), `Missing native ${type}.`);
  assert.equal(providerRequests, 3);
  assert.deepEqual(
    await artifactHashes(),
    measuredHashes,
    "Validation sources or built TUI changed during the runtime probe.",
  );
  const report = {
    schema: 1,
    runtime: { opencode: expectedVersion, platform: process.platform, bun: Bun.version },
    artifact: {
      baseGitRevision,
      sha256: measuredHashes,
      receipt:
        "Source and built TUI hashes captured before launch and verified unchanged after the final frame assertions. The uncommitted source hashes identify this validation build.",
    },
    scope:
      "Actual stock TUI, actual sidebar, real PTY mark/pin/collapse, native child question/permission from deterministic loopback provider.",
    checks: [
      "Marked pinned parent retains completion while displaying child busy/question.",
      "Collapsed All sessions retains busy/question summary.",
      "From a separate idle session route, narrow 88x24 browse retains completion and question footer; session menu retains busy/question labels.",
      "Question reply transitions to native permission with mark and collapsed summary retained.",
      "Permission reply clears attention and busy labels without clearing completion.",
    ],
    providerRequests,
    captures: frames.map(({ name, frame }) => ({ name, width: frame.width, height: frame.height })),
    limitations: [
      "No external provider or model inference; native host tool handling receives synthetic loopback completion chunks.",
      "No native retry, remote disconnect, cross-platform render, or performance claim from this focused smoke.",
    ],
  };
  if (process.env.SIDEBAR_ATTENTION_REPORT)
    await writeFile(
      resolve(process.env.SIDEBAR_ATTENTION_REPORT),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  console.log(
    `Stock OpenCode ${expectedVersion}: marked parent and collapsed-group native question/permission rendering passed (${providerRequests} loopback provider requests).`,
  );
} finally {
  clearTimeout(deadline);
  lifetime.abort();
  if (child) {
    child.kill("SIGKILL");
    await child.exited;
    child.terminal?.close();
  }
  await fixture?.stop(true);
  if (process.env.SIDEBAR_ATTENTION_KEEP_TEMP === "true")
    console.error(`Synthetic test artifacts: ${root}`);
  else await rm(root, { recursive: true, force: true });
}
