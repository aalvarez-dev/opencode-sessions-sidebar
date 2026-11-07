import { describe, expect, test } from "bun:test";
import { monitorV1Transport } from "../src/adapters/opencode-v1/transport-health";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const settle = async () => {
  for (let turn = 0; turn < 4; turn++) await Promise.resolve();
};

class Clock {
  now = 0;
  tasks = new Set<{ at: number; run: () => void }>();
  schedule = (run: () => void, delay: number) => {
    const task = { at: this.now + delay, run };
    this.tasks.add(task);
    return () => this.tasks.delete(task);
  };
  advance(ms: number) {
    const target = this.now + ms;
    while (true) {
      const next = [...this.tasks].sort((a, b) => a.at - b.at)[0];
      if (!next || next.at > target) break;
      this.now = next.at;
      this.tasks.delete(next);
      next.run();
    }
    this.now = target;
  }
}

function fixture() {
  const clock = new Clock();
  const lifetime = new AbortController();
  const changes: boolean[] = [];
  const requests: {
    signal: AbortSignal;
    reply: ReturnType<typeof deferred<{ data: { healthy: boolean } }>>;
  }[] = [];
  let currentClient = "first";
  const clients: string[] = [];
  const host = {
    get client() {
      clients.push(currentClient);
      return {
        global: {
          health: (options: { signal: AbortSignal; throwOnError: boolean }) => {
            expect(options.throwOnError).toBe(true);
            const reply = deferred<{ data: { healthy: boolean } }>();
            requests.push({ signal: options.signal, reply });
            return reply.promise;
          },
        },
      };
    },
    lifecycle: { signal: lifetime.signal },
  } as unknown as Parameters<typeof monitorV1Transport>[0];
  const stop = monitorV1Transport(host, (available) => changes.push(available), clock.schedule);
  return {
    clock,
    lifetime,
    changes,
    requests,
    clients,
    stop,
    swapClient: () => (currentClient = "second"),
  };
}

describe("bounded TUI transport-health fallback", () => {
  test("checks only every minute and stable health produces no UI notifications", async () => {
    const f = fixture();
    f.clock.advance(59_999);
    expect(f.requests).toHaveLength(0);
    f.clock.advance(1);
    expect(f.requests).toHaveLength(1);
    f.requests[0]!.reply.resolve({ data: { healthy: true } });
    await settle();
    f.swapClient();
    f.clock.advance(60_000);
    expect(f.requests).toHaveLength(2);
    f.requests[1]!.reply.resolve({ data: { healthy: true } });
    await settle();
    expect(f.changes).toEqual([]);
    expect(f.clients).toEqual(["first", "second"]);
    f.stop();
    expect(f.clock.tasks.size).toBe(0);
  });

  test("fulfilled health responses release their deadline without aborting consumed bodies", async () => {
    for (const healthy of [true, false]) {
      const f = fixture();
      f.clock.advance(60_000);
      f.clock.advance(400);
      f.requests[0]!.reply.resolve({ data: { healthy } });
      await settle();
      expect(f.requests[0]!.signal.aborted).toBe(false);
      expect(f.changes).toEqual(healthy ? [] : [false]);
      expect(f.clock.tasks.size).toBe(1);

      // Passing the old deadline must neither cancel a consumed response nor
      // report another failure. Only known outages use the shorter retry interval.
      f.clock.advance((healthy ? 60_000 : 15_000) - 1);
      expect(f.requests).toHaveLength(1);
      expect(f.requests[0]!.signal.aborted).toBe(false);
      expect(f.changes).toEqual(healthy ? [] : [false]);
      f.clock.advance(1);
      expect(f.requests).toHaveLength(2);
      f.stop();
      expect(f.requests[1]!.signal.aborted).toBe(true);
      expect(f.requests[0]!.signal.aborted).toBe(false);
      expect(f.clock.tasks.size).toBe(0);
    }
  });

  test("reports each failed probe but not repeated healthy responses", async () => {
    const f = fixture();
    for (let index = 0; index < 2; index++) {
      f.clock.advance(index === 0 ? 60_000 : 15_000);
      f.requests[index]!.reply.reject(new Error("transport cut"));
      await settle();
      expect(f.requests[index]!.signal.aborted).toBe(true);
      expect(f.clock.tasks.size).toBe(1);
    }
    expect(f.changes).toEqual([false, false]);
    f.clock.advance(15_000);
    f.requests[2]!.reply.resolve({ data: { healthy: true } });
    await settle();
    expect(f.changes).toEqual([false, false, true]);
    f.clock.advance(59_999);
    expect(f.requests).toHaveLength(3);
    f.clock.advance(1);
    expect(f.requests).toHaveLength(4);
    f.requests[3]!.reply.resolve({ data: { healthy: true } });
    await settle();
    expect(f.changes).toEqual([false, false, true]);
    f.stop();
  });

  test("a timed-out noncooperative read cannot restore certainty or accumulate retries", async () => {
    const f = fixture();
    f.clock.advance(60_000);
    f.clock.advance(1_999);
    expect(f.changes).toEqual([]);
    f.clock.advance(1);
    expect(f.changes).toEqual([false]);
    expect(f.requests[0]!.signal.aborted).toBe(true);
    f.clock.advance(60_000);
    expect(f.requests).toHaveLength(1);
    expect(f.clock.tasks.size).toBe(0);
    f.requests[0]!.reply.resolve({ data: { healthy: true } });
    await settle();
    expect(f.changes).toEqual([false]);
    expect(f.requests[0]!.signal.aborted).toBe(true);
    expect(f.clock.tasks.size).toBe(1);
    f.clock.advance(15_000);
    f.requests[1]!.reply.resolve({ data: { healthy: true } });
    await settle();
    expect(f.changes).toEqual([false, true]);
    f.stop();
  });

  test("disposal and host abort cancel deadlines and ignore late responses", async () => {
    for (const abortHost of [false, true]) {
      const f = fixture();
      f.clock.advance(60_000);
      if (abortHost) f.lifetime.abort();
      else f.stop();
      expect(f.requests[0]!.signal.aborted).toBe(true);
      expect(f.clock.tasks.size).toBe(0);
      f.requests[0]!.reply.resolve({ data: { healthy: false } });
      await settle();
      f.clock.advance(60_000);
      expect(f.changes).toEqual([]);
      expect(f.requests).toHaveLength(1);
      expect(f.clock.tasks.size).toBe(0);
      f.stop();
    }
  });
});
