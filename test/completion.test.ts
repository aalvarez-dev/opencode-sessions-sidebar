import { describe, expect, test } from "bun:test";
import {
  applyCompletionActivity,
  createCompletionState,
  setCompletion,
  type CompletionActivity,
  type CompletionPolicy,
  type CompletionPolicyContext,
  type CompletionState,
  type WorkflowCorrelation,
} from "../src/core";

const user = { type: "user" } as const;
const host = { type: "host" } as const;
const reporter = { type: "extension", id: "example-report" } as const;

function mark(
  state = createCompletionState("server-a/project/session-1"),
  sequence = 0,
  eventId = "mark-1",
) {
  return setCompletion(state, { done: true, executionSequence: sequence, eventId, origin: user })
    .state;
}

function started(
  sequence: number,
  overrides: Partial<CompletionActivity> = {},
): CompletionActivity {
  return {
    type: "execution.started",
    executionSequence: sequence,
    eventId: `execution-${sequence}`,
    origin: host,
    ...overrides,
  } as CompletionActivity;
}

function correlation(state: CompletionState): WorkflowCorrelation {
  return {
    workflowId: "report-run-1",
    name: "example-report",
    causedByEventId: state.markEventId!,
    markRevision: state.revision,
  };
}

describe("visual completion", () => {
  test("zero is a marking frontier, never a valid start or finish sequence", () => {
    const initial = createCompletionState("session");
    const marked = mark(initial, 0);
    expect(initial.executionSequence).toBe(0);
    expect(marked.done).toBe(true);

    for (const activity of [
      started(0),
      {
        type: "execution.finished",
        executionSequence: 0,
        eventId: "invalid-finish",
        origin: host,
        expectedRevision: marked.revision,
      },
      {
        type: "execution.finished",
        executionSequence: 0,
        eventId: "invalid-stale-finish",
        origin: host,
        expectedRevision: marked.revision - 1,
      },
    ] satisfies CompletionActivity[]) {
      expect(() => applyCompletionActivity(marked, activity)).toThrow(
        "Execution event sequences start at 1",
      );
    }
    expect(applyCompletionActivity(marked, started(1)).state.done).toBe(false);
  });

  test("change descriptions identify their cause without claiming a unique output event ID", () => {
    const input = { eventId: "shared-input", origin: user, executionSequence: 0 };
    const marked = setCompletion(createCompletionState("session"), { ...input, done: true });
    const cleared = setCompletion(marked.state, { ...input, done: false });
    expect(marked.change).toMatchObject({
      causedByEventId: input.eventId,
      before: false,
      after: true,
      revision: 1,
    });
    expect(cleared.change).toMatchObject({
      causedByEventId: input.eventId,
      before: true,
      after: false,
      revision: 2,
    });
    expect(marked.change).not.toHaveProperty("eventId");
    expect(cleared.change).not.toHaveProperty("eventId");
    expect(marked.state.markEventId).toBe(input.eventId);
  });

  test("explicit marking during existing work survives observations and replays of that execution", () => {
    const active = applyCompletionActivity(createCompletionState("session"), started(8)).state;
    const marked = mark(active, 8);
    expect(marked.done).toBe(true);

    for (const status of ["busy", "idle", "unknown"] as const) {
      const result = applyCompletionActivity(marked, {
        type: "runtime.observed",
        status,
        eventId: `snapshot-${status}`,
        origin: host,
        expectedRevision: marked.revision,
      });
      expect(result.state).toBe(marked);
      expect(result.change).toBeUndefined();
    }
    expect(applyCompletionActivity(marked, started(8)).state).toBe(marked);
    expect(applyCompletionActivity(marked, started(7)).state).toBe(marked);

    const reopened = applyCompletionActivity(marked, started(9));
    expect(reopened.state.done).toBe(false);
    expect(reopened.change).toMatchObject({
      before: true,
      after: false,
      reason: "execution.started",
    });
    expect(marked.done).toBe(true);
  });

  test("repeated explicit values are no-ops and stale extension writes cannot override a newer mark", () => {
    const marked = mark();
    const repeated = setCompletion(marked, {
      done: true,
      executionSequence: 0,
      eventId: "mark-again",
      origin: user,
    });
    expect(repeated.state).toBe(marked);
    expect(repeated.change).toBeUndefined();

    const opened = applyCompletionActivity(marked, started(1)).state;
    const stale = setCompletion(opened, {
      done: true,
      executionSequence: 100,
      eventId: "late-report-result",
      origin: reporter,
      expectedRevision: marked.revision,
    });
    expect(stale.state).toBe(opened);
    expect(stale.change).toBeUndefined();
    expect(stale.state.executionSequence).toBe(1);
  });

  test("manual policy keeps completion while still acknowledging execution evidence", () => {
    const marked = mark();
    const result = applyCompletionActivity(marked, started(1), { mode: "manual" });
    expect(result.state).toMatchObject({
      done: true,
      revision: marked.revision,
      executionSequence: 1,
    });
    expect(result.change).toBeUndefined();
    // Changing configuration must not reinterpret the same start as new work.
    expect(applyCompletionActivity(result.state, started(1)).state).toBe(result.state);
  });

  test("stale completion results cannot mark newer work when the visual revision is unchanged", () => {
    const first = applyCompletionActivity(createCompletionState("session"), started(1)).state;
    const newer = applyCompletionActivity(first, started(2)).state;
    expect(newer.revision).toBe(first.revision);

    const staleRequest = setCompletion(newer, {
      done: true,
      executionSequence: first.executionSequence,
      eventId: "late-mark-request",
      origin: reporter,
      expectedRevision: first.revision,
    });
    expect(staleRequest.state).toBe(newer);
    let calls = 0;
    const staleResult = applyCompletionActivity(
      newer,
      {
        type: "execution.finished",
        executionSequence: first.executionSequence,
        eventId: "old-execution-finished",
        origin: host,
        expectedRevision: first.revision,
      },
      {
        mode: "custom",
        decide: () => {
          calls += 1;
          return "mark";
        },
      },
    );
    expect(staleResult.state).toBe(newer);
    expect(calls).toBe(0);
  });

  test("an old expected revision cannot suppress genuinely new execution", () => {
    const marked = mark();
    const result = applyCompletionActivity(marked, started(1, { expectedRevision: 0 }));
    expect(result.state.done).toBe(false);
    expect(result.state.executionSequence).toBe(1);
    expect(result.change?.reason).toBe("execution.started");
  });

  test("idle and completed work do not automatically mark a session", () => {
    const working = applyCompletionActivity(createCompletionState("session"), started(1)).state;
    for (const activity of [
      { type: "execution.finished", executionSequence: 1 },
      { type: "runtime.observed", status: "idle" },
    ] as const) {
      const result = applyCompletionActivity(working, {
        ...activity,
        eventId: activity.type,
        origin: host,
        expectedRevision: working.revision,
      });
      expect(result.state.done).toBe(false);
      expect(result.change).toBeUndefined();
    }
  });

  test("a stale runtime observation cannot invoke a policy against a newer manual choice", () => {
    const marked = mark();
    let calls = 0;
    const result = applyCompletionActivity(
      marked,
      {
        type: "runtime.observed",
        status: "idle",
        eventId: "old-snapshot",
        origin: host,
        expectedRevision: marked.revision - 1,
      },
      {
        mode: "custom",
        decide: () => {
          calls += 1;
          return "clear";
        },
      },
    );
    expect(result.state).toBe(marked);
    expect(result.change).toBeUndefined();
    expect(calls).toBe(0);
  });

  test("a confirmed finish advances the frontier after missed starts without changing the mark", () => {
    const marked = mark();
    const finished = applyCompletionActivity(marked, {
      type: "execution.finished",
      executionSequence: 3,
      eventId: "finish-after-gap",
      origin: host,
      expectedRevision: marked.revision,
    });
    expect(finished.state).toMatchObject({
      done: true,
      executionSequence: 3,
      revision: marked.revision,
    });
    expect(finished.change).toBeUndefined();
    for (const sequence of [1, 2, 3]) {
      expect(applyCompletionActivity(finished.state, started(sequence)).state).toBe(finished.state);
    }
    expect(applyCompletionActivity(finished.state, started(4)).state.done).toBe(false);
  });

  test("a restarted or out-of-order sequence cannot claim unproven new work", () => {
    const marked = mark(undefined, 42);
    expect(applyCompletionActivity(marked, started(1)).state).toBe(marked);
    expect(applyCompletionActivity(marked, started(43)).state.done).toBe(false);
    expect(() => applyCompletionActivity(marked, started(Number.NaN))).toThrow(RangeError);
  });
});

describe("correlated completion workflows", () => {
  const policy: CompletionPolicy = { mode: "on-execution", preserveFor: ["example-report"] };

  test("a preserved report does not suppress concurrent user work or remark it on completion", () => {
    const marked = mark();
    const workflow = correlation(marked);
    const report = applyCompletionActivity(
      marked,
      started(1, { origin: reporter, workflow }),
      policy,
    );
    expect(report.state.done).toBe(true);
    expect(report.change).toBeUndefined();

    const userWork = applyCompletionActivity(report.state, started(2, { origin: user }), policy);
    expect(userWork.state.done).toBe(false);
    expect(userWork.change?.origin).toEqual(user);

    const lateReport = applyCompletionActivity(
      userWork.state,
      {
        type: "workflow.finished",
        eventId: "report-finished",
        origin: reporter,
        workflow,
        expectedRevision: marked.revision,
      },
      { mode: "custom", decide: () => "mark" },
    );
    expect(lateReport.state).toBe(userWork.state);
    expect(lateReport.change).toBeUndefined();
  });

  test("a late report cannot control a newer manually applied mark", () => {
    const first = mark();
    const workflow = correlation(first);
    const opened = applyCompletionActivity(first, started(1)).state;
    const newer = mark(opened, 1, "new-mark");
    let policyCalls = 0;
    const result = applyCompletionActivity(
      newer,
      {
        type: "workflow.finished",
        eventId: "old-report-finished",
        origin: reporter,
        workflow,
        // Even a caller with the current revision must match the causal mark.
        expectedRevision: newer.revision,
      },
      {
        mode: "custom",
        decide: () => {
          policyCalls += 1;
          return "clear";
        },
      },
    );
    expect(result.state).toBe(newer);
    expect(policyCalls).toBe(0);
  });

  test("a matching name alone, incorrect cause, or old mark revision does not grant preservation", () => {
    const marked = mark();
    const valid = correlation(marked);
    for (const workflow of [
      { ...valid, workflowId: "" },
      { ...valid, causedByEventId: "unrelated-mark" },
      { ...valid, markRevision: marked.revision - 1 },
      { ...valid, name: "other-extension" },
    ]) {
      const result = applyCompletionActivity(
        marked,
        started(1, { origin: reporter, workflow }),
        policy,
      );
      expect(result.state.done).toBe(false);
    }
    expect(
      applyCompletionActivity(marked, started(1, { origin: { type: "unknown" } }), policy).state
        .done,
    ).toBe(false);
  });

  test("replayed preserved starts cannot later clear the same mark", () => {
    const marked = mark();
    const event = started(1, { origin: reporter, workflow: correlation(marked) });
    const preserved = applyCompletionActivity(marked, event, policy).state;
    const duplicate = applyCompletionActivity(preserved, event);
    expect(duplicate.state).toBe(preserved);
    expect(duplicate.change).toBeUndefined();
  });

  test("finishing a report has no default completion side effect", () => {
    const marked = mark();
    const result = applyCompletionActivity(
      marked,
      {
        type: "workflow.finished",
        eventId: "report-finished",
        origin: reporter,
        workflow: correlation(marked),
        expectedRevision: marked.revision,
      },
      policy,
    );
    expect(result.state).toBe(marked);
    expect(result.change).toBeUndefined();
  });
});

describe("custom completion decisions", () => {
  test("custom decisions see the pre-event state while accepted evidence advances the returned frontier", () => {
    const marked = mark(undefined, 4);
    let observed: CompletionPolicyContext | undefined;
    const result = applyCompletionActivity(marked, started(5), {
      mode: "custom",
      decide: (context) => {
        observed = context;
        return "keep";
      },
    });
    expect(observed).toMatchObject({
      state: { executionSequence: 4, done: true },
      activity: { type: "execution.started", executionSequence: 5 },
    });
    expect(result.diagnostic).toBeUndefined();
    expect(result.state).toMatchObject({
      done: true,
      executionSequence: 5,
      revision: marked.revision,
    });
    expect(result.change).toBeUndefined();
  });

  test("policy inputs are detached frozen snapshots, including origin and workflow", () => {
    const marked = mark();
    const workflow = correlation(marked);
    const activity = started(1, { origin: reporter, workflow });
    let observed: CompletionPolicyContext | undefined;
    const mutationResults: boolean[] = [];
    const result = applyCompletionActivity(marked, activity, {
      mode: "custom",
      decide: (context) => {
        observed = context;
        mutationResults.push(
          Reflect.set(context.state, "done", false),
          Reflect.set(context.activity.origin, "id", "changed"),
          Reflect.set(context.activity.workflow!, "markRevision", 999),
        );
        throw new Error("mutation attempt followed by failure");
      },
    });
    expect(observed).toBeDefined();
    expect(observed?.state).not.toBe(marked);
    expect(observed?.activity).not.toBe(activity);
    expect(observed?.activity.origin).not.toBe(reporter);
    expect(observed?.activity.workflow).not.toBe(workflow);
    expect(mutationResults).toEqual([false, false, false]);
    expect(marked.done).toBe(true);
    expect(reporter.id).toBe("example-report");
    expect(workflow.markRevision).toBe(marked.revision);
    expect(result.state.done).toBe(true);
    expect(result.change).toBeUndefined();
    expect(result.diagnostic).toEqual({
      code: "policy-error",
      message: "mutation attempt followed by failure",
    });
  });

  test("custom policies can mark, clear, keep, or delegate without changing the default policy", () => {
    const empty = createCompletionState("session");
    const finished: CompletionActivity = {
      type: "execution.finished",
      executionSequence: 1,
      eventId: "finished-1",
      origin: host,
      expectedRevision: empty.revision,
    };
    const marked = applyCompletionActivity(empty, finished, {
      mode: "custom",
      decide: () => "mark",
    });
    expect(marked.state.done).toBe(true);
    expect(marked.change?.reason).toBe("policy");
    expect(
      applyCompletionActivity(marked.state, finished, { mode: "custom", decide: () => "clear" })
        .state,
    ).toBe(marked.state);

    const kept = applyCompletionActivity(marked.state, started(2), {
      mode: "custom",
      decide: () => "keep",
    });
    expect(kept.state.done).toBe(true);
    expect(kept.change).toBeUndefined();
    const delegated = applyCompletionActivity(kept.state, started(3), {
      mode: "custom",
      decide: ({ defaultDecision }) => {
        expect(defaultDecision).toBe("clear");
        return "default";
      },
    });
    expect(delegated.state.done).toBe(false);
    expect(delegated.change?.reason).toBe("execution.started");

    const cleared = applyCompletionActivity(marked.state, started(2), {
      mode: "custom",
      decide: () => "clear",
    });
    expect(cleared.state.done).toBe(false);
    expect(cleared.change?.reason).toBe("policy");
  });

  test("policy failures preserve the mark, report a diagnostic, and do not retry duplicate facts", () => {
    const marked = mark();
    let calls = 0;
    const policy: CompletionPolicy = {
      mode: "custom",
      decide: () => {
        calls += 1;
        throw new Error("broken policy");
      },
    };
    const failed = applyCompletionActivity(marked, started(1), policy);
    expect(failed.state.done).toBe(true);
    expect(failed.change).toBeUndefined();
    expect(failed.diagnostic).toEqual({ code: "policy-error", message: "broken policy" });
    expect(applyCompletionActivity(failed.state, started(1), policy).state).toBe(failed.state);
    expect(calls).toBe(1);
  });

  test("an invalid JavaScript policy decision preserves the mark and reports the contract violation", () => {
    const marked = mark();
    const policy: CompletionPolicy = {
      mode: "custom",
      // @ts-expect-error Simulate a JavaScript caller violating the typed decision contract.
      decide: () => "unsupported-decision",
    };
    const result = applyCompletionActivity(marked, started(1), policy);
    expect(result.state).toMatchObject({
      done: true,
      executionSequence: 1,
      revision: marked.revision,
    });
    expect(result.change).toBeUndefined();
    expect(result.diagnostic?.code).toBe("invalid-policy-decision");
    expect(applyCompletionActivity(result.state, started(1), policy).state).toBe(result.state);
  });

  test("async policies are rejected by types and runtime; their delayed answer is never applied", async () => {
    const marked = mark();
    const policy: CompletionPolicy = {
      mode: "custom",
      // @ts-expect-error Completion policies cannot return promises.
      decide: async () => "clear",
    };
    const result = applyCompletionActivity(marked, started(1), policy);
    await Promise.resolve();
    expect(result.state.done).toBe(true);
    expect(result.change).toBeUndefined();
    expect(result.diagnostic?.code).toBe("async-policy");
  });
});
