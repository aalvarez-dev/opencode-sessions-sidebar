/** Real OpenCode attention events driven by a deterministic loopback provider. No model inference. */
import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { createOpencodeClient, type Event } from "@opencode-ai/sdk/v2";
import { createV1Adapter } from "../src/adapters/opencode-v1/index.js";
import type { V1HostPort } from "../src/adapters/opencode-v1/types.js";

const versionExpected = "1.18.30";
assert(process.env.OPENCODE_BIN, "Set OPENCODE_BIN to stock OpenCode 1.18.30.");
const executable = await realpath(process.env.OPENCODE_BIN);
const root = await mkdtemp(join(tmpdir(), "sidebar-v1-attention-"));
const directory = join(root, "project");
const config = join(root, "config");
const lifetime = new AbortController();
const streamController = new AbortController();
let processHost: ReturnType<typeof Bun.spawn> | undefined;
let adapter: ReturnType<typeof createV1Adapter> | undefined;
let stream: Promise<void> | undefined;
let streamError: unknown;
let providerError: unknown;
let providerRequests = 0;
let fixture: ReturnType<typeof Bun.serve> | undefined;
const processDrains: Promise<void>[] = [];
const timeout = setTimeout(() => {
  lifetime.abort(new Error("Runtime attention smoke exceeded 75 seconds."));
  streamController.abort();
  processHost?.kill("SIGKILL");
}, 75_000);

async function until(check: () => boolean, message: string, budget = 10_000) {
  const started = performance.now();
  while (!check()) {
    lifetime.signal.throwIfAborted();
    if (streamError) throw streamError;
    if (providerError) throw providerError;
    assert(performance.now() - started < budget, message);
    await Bun.sleep(20);
  }
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
  // V1 reads macOS managed preferences independently of the test-managed-directory override.
  if (process.platform === "darwin") {
    for (const path of [
      "/Library/Managed Preferences/ai.opencode.managed.plist",
      join("/Library/Managed Preferences", userInfo().username, "ai.opencode.managed.plist"),
    ]) {
      const present = await lstat(path).then(
        () => true,
        (error: unknown) => {
          if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
            return false;
          throw error;
        },
      );
      assert(!present, "Use an unmanaged test host for this isolated probe.");
    }
  }
  fixture = startFixture();
  await Promise.all([mkdir(directory), mkdir(join(config, "opencode"), { recursive: true })]);
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
  };
  const version = Bun.spawn([executable, "--version"], {
    cwd: directory,
    env,
    stdout: "pipe",
    stderr: "pipe",
    signal: lifetime.signal,
  });
  assert.equal((await new Response(version.stdout).text()).trim(), versionExpected);
  assert.equal(await version.exited, 0);
  processHost = Bun.spawn([executable, "serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: directory,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  let baseUrl: string | undefined;
  const stdout = processHost.stdout;
  assert(stdout && typeof stdout !== "number");
  const drain = (async () => {
    let output = "";
    for await (const chunk of stdout) {
      output = (output + new TextDecoder().decode(chunk)).slice(-4096);
      baseUrl ??= output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    }
  })();
  const stderr = processHost.stderr;
  assert(stderr && typeof stderr !== "number");
  // Drain bounded diagnostics without printing runtime paths or synthetic session contents.
  const errors = (async () => {
    for await (const _chunk of stderr) {
      /* drain */
    }
  })();
  processDrains.push(drain, errors);
  await until(() => Boolean(baseUrl), "Stock server did not start.", 45_000);
  assert(baseUrl);
  const client = createOpencodeClient({ baseUrl });
  const project = await client.project.current(
    { directory },
    { throwOnError: true, signal: lifetime.signal },
  );
  assert(project.data);
  const listeners = new Map<Event["type"], Set<(event: Event) => void>>();
  const host: V1HostPort = {
    client,
    event: {
      on(type, handler) {
        const set = listeners.get(type) ?? new Set();
        const receive = handler as (event: Event) => void;
        set.add(receive);
        listeners.set(type, set);
        return () => {
          set.delete(receive);
        };
      },
    },
    lifecycle: {
      signal: lifetime.signal,
      onDispose() {
        return () => {};
      },
    },
    route: { current: { name: "home" }, navigate() {} },
  };
  const events: Event[] = [];
  stream = (async () => {
    const subscription = await client.event.subscribe(
      { directory },
      { signal: streamController.signal, sseMaxRetryAttempts: 0 },
    );
    for await (const event of subscription.stream) {
      if (streamController.signal.aborted) break;
      events.push(event);
      assert(events.length <= 512, "Unexpected event volume in the synthetic fixture.");
      for (const handler of listeners.get(event.type) ?? []) handler(event);
    }
  })().catch((error: unknown) => {
    if (!streamController.signal.aborted) streamError = error;
  });
  await until(
    () => events.some((event) => event.type === "server.connected"),
    "No real connection event.",
  );
  adapter = createV1Adapter(host, {
    hostId: "synthetic-runtime",
    projectId: project.data.id,
    directory,
  });
  await adapter.start();
  assert.equal(adapter.state().phase, "ready");
  const parent = await client.session.create(
    { directory, title: "Synthetic attention parent" },
    { throwOnError: true, signal: lifetime.signal },
  );
  assert(parent.data);
  const parentId = parent.data.id;
  const child = await client.session.create(
    { directory, parentID: parentId, title: "Synthetic attention child" },
    { throwOnError: true, signal: lifetime.signal },
  );
  assert(child.data);
  const childId = child.data.id;
  await until(() => Boolean(adapter?.get(childId)), "Child event not observed.");
  const prompt = client.session.prompt(
    {
      directory,
      sessionID: childId,
      model: { providerID: "synthetic", modelID: "synthetic" },
      parts: [{ type: "text", text: "Run the synthetic runtime attention fixture." }],
    },
    { throwOnError: true, signal: lifetime.signal },
  );
  void prompt.catch((error: unknown) => {
    providerError = error;
  });
  await until(() => adapter?.get(childId)?.questions === 1, "No real pending question.", 25_000);
  assert.equal(adapter.get(childId)?.activity, "busy");
  assert.equal(adapter.summary(parentId)?.questions, 1);
  assert.equal(adapter.summary(parentId)?.busy, 1);
  await adapter.refresh();
  assert.equal(adapter.state().phase, "ready");
  assert.equal(adapter.get(childId)?.questions, 1);
  assert.equal(adapter.summary(parentId)?.questions, 1);
  const questions = await client.question.list(
    { directory },
    { throwOnError: true, signal: lifetime.signal },
  );
  assert.equal(questions.data?.length, 1);
  const question = questions.data[0];
  assert(question);
  assert.equal(question.sessionID, childId);
  await client.question.reply(
    { directory, requestID: question.id, answers: [["Continue"]] },
    { throwOnError: true, signal: lifetime.signal },
  );
  await until(() => adapter?.get(childId)?.permissions === 1, "No real pending permission.");
  assert.equal(adapter.get(childId)?.questions, 0);
  assert.equal(adapter.summary(parentId)?.permissions, 1);
  await adapter.refresh();
  assert.equal(adapter.state().phase, "ready");
  assert.equal(adapter.get(childId)?.permissions, 1);
  assert.equal(adapter.summary(parentId)?.permissions, 1);
  const permissions = await client.permission.list(
    { directory },
    { throwOnError: true, signal: lifetime.signal },
  );
  assert.equal(permissions.data?.length, 1);
  const permission = permissions.data[0];
  assert(permission);
  assert.equal(permission.sessionID, childId);
  assert.equal(permission.permission, "bash");
  await client.permission.reply(
    { directory, requestID: permission.id, reply: "once" },
    { throwOnError: true, signal: lifetime.signal },
  );
  await prompt;
  await until(
    () =>
      adapter?.get(childId)?.activity === "idle" && adapter?.summary(parentId)?.permissions === 0,
    "Attention did not clear or session did not become idle.",
  );
  assert.equal(adapter.summary(parentId)?.questions, 0);
  assert.equal(adapter.summary(parentId)?.busy, 0);
  assert.equal(providerRequests, 3);
  assert.equal(adapter.state().executionCorrelation, "unavailable");
  for (const type of [
    "session.status",
    "question.asked",
    "question.replied",
    "permission.asked",
    "permission.replied",
  ] as const) {
    const seen = events.filter((event) => event.type === type);
    assert(seen.length > 0, `Missing real ${type} event.`);
    assert(seen.every((event) => event.id.startsWith("evt_")));
  }
  adapter.dispose();
  assert([...listeners.values()].every((set) => set.size === 0));
  streamController.abort();
  await stream;
  processHost.kill("SIGKILL");
  await processHost.exited;
  await Promise.all(processDrains);
  console.log(
    `Stock OpenCode ${versionExpected}: live busy, child question/permission, ancestor summaries, replies, idle and disposal passed.`,
  );
  console.log(
    `Deterministic loopback provider: ${providerRequests} requests; no external provider or model inference. SDK/SSE bridge, not TUI rendering.`,
  );
} finally {
  clearTimeout(timeout);
  lifetime.abort();
  streamController.abort();
  adapter?.dispose();
  if (processHost) {
    processHost.kill("SIGKILL");
    await processHost.exited;
  }
  await stream;
  await Promise.allSettled(processDrains);
  await fixture?.stop(true);
  await rm(root, { recursive: true, force: true });
}
