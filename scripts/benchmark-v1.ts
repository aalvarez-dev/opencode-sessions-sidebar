import { createOpencodeClient, type Event, type Session } from "@opencode-ai/sdk/v2";
import { createV1Adapter, type V1HostPort } from "../src/adapters/opencode-v1";

// A component probe with synthetic data and an in-memory SDK transport. This
// measures neither terminal rendering nor stock-OpenCode process overhead.
const sessionCount = 1_000;
const eventCount = 10_000;
const eventBudgetMs = 2;
const activationBudgetMs = 250;
const scope = { hostId: "benchmark-host", projectId: "benchmark-project", directory: "/synthetic" };
const sessions: Session[] = Array.from({ length: sessionCount }, (_, index) => ({
  id: `session-${index}`,
  slug: `session-${index}`,
  projectID: scope.projectId,
  directory: scope.directory,
  title: `Synthetic session ${index}`,
  version: "1.18.30",
  time: { created: index, updated: index },
}));
let requests = 0;
const client = createOpencodeClient({
  baseUrl: "http://synthetic.invalid",
  fetch: Object.assign(
    async (request: Parameters<typeof fetch>[0]) => {
      requests += 1;
      const path = new URL(request instanceof Request ? request.url : request.toString()).pathname;
      const data = path === "/session" ? sessions : path === "/session/status" ? {} : [];
      return Response.json(data);
    },
    { preconnect() {} },
  ),
});
const handlers = new Map<Event["type"], (event: Event) => void>();
const lifetime = new AbortController();
const host: V1HostPort = {
  client,
  event: {
    on(type, handler) {
      handlers.set(type, handler as (event: Event) => void);
      return () => {
        handlers.delete(type);
      };
    },
  },
  lifecycle: { signal: lifetime.signal, onDispose: () => () => {} },
  route: { current: { name: "home" }, navigate: () => {} },
};
const adapter = createV1Adapter(host, scope, { maxSessions: sessionCount + 1 });
let changed = 0;
let largestChange = 0;
const unsubscribe = adapter.subscribe((change) => {
  changed += 1;
  largestChange = Math.max(largestChange, change.sessionIds.length);
});
try {
  const before = performance.now();
  await adapter.start();
  const activationMs = performance.now() - before;
  if (adapter.list().length !== sessionCount || adapter.state().phase !== "ready") {
    throw new Error("Synthetic bootstrap failed");
  }
  const initialRequests = requests;
  changed = 0;
  largestChange = 0;
  const samples: number[] = [];
  for (let index = 0; index < eventCount; index += 1) {
    const event: Event = {
      id: `event-${index}`,
      type: "session.status",
      properties: { sessionID: "session-0", status: { type: index % 2 ? "idle" : "busy" } },
    };
    const start = performance.now();
    handlers.get(event.type)?.(event);
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const p95Ms = samples[Math.floor(samples.length * 0.95)]!;
  const report = {
    environment: { platform: process.platform, arch: process.arch, bun: Bun.version },
    sessionCount,
    eventCount,
    activationMs,
    p50Ms: samples[Math.floor(samples.length * 0.5)],
    p95Ms,
    activationBudgetMs,
    eventBudgetMs,
    initialRequests,
    eventRequests: requests - initialRequests,
    changes: changed,
    largestChange,
    retainedEventIds: adapter.state().eventIdCount,
  };
  console.log(JSON.stringify(report, null, 2));
  if (
    activationMs > activationBudgetMs ||
    p95Ms > eventBudgetMs ||
    requests !== initialRequests ||
    largestChange > 1 ||
    changed !== eventCount
  ) {
    throw new Error("Component probe exceeded a predeclared budget or correctness bound");
  }
} finally {
  unsubscribe();
  adapter.dispose();
  if (handlers.size !== 0) throw new Error("Event subscriptions survived disposal");
}
