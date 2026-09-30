import type {
  CompletionActivity,
  CompletionChange,
  CompletionDecision,
  CompletionEventContext,
  CompletionPolicy,
  CompletionResult,
  CompletionState,
  SetCompletionInput,
} from "./types";

export function createCompletionState(sessionKey: string): CompletionState {
  return Object.freeze({
    sessionKey,
    done: false,
    revision: 0,
    executionSequence: 0,
    markEventId: null,
  });
}

function assertSequence(sequence: number): void {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new RangeError("Execution sequence must be a non-negative safe integer");
  }
}

function assertExecutionSequence(sequence: number): void {
  assertSequence(sequence);
  if (sequence === 0) {
    throw new RangeError(
      "Execution event sequences start at 1; 0 is reserved for the initial frontier",
    );
  }
}

function withFrontier(state: CompletionState, sequence: number): CompletionState {
  assertSequence(sequence);
  return sequence > state.executionSequence
    ? Object.freeze({ ...state, executionSequence: sequence })
    : state;
}

function snapshotContext(context: CompletionEventContext): CompletionEventContext {
  return {
    eventId: context.eventId,
    origin: Object.freeze({ ...context.origin }),
    ...(context.workflow ? { workflow: Object.freeze({ ...context.workflow }) } : {}),
    ...(context.expectedRevision === undefined
      ? {}
      : { expectedRevision: context.expectedRevision }),
  };
}

function changeMark(
  state: CompletionState,
  done: boolean,
  context: CompletionEventContext,
  reason: CompletionChange["reason"],
): CompletionResult {
  if (done === state.done) return { state };
  const revision = state.revision + 1;
  const { eventId, ...changeContext } = snapshotContext(context);
  return {
    state: Object.freeze({
      ...state,
      done,
      revision,
      markEventId: done ? context.eventId : null,
    }),
    change: Object.freeze({
      ...changeContext,
      type: "completion.changed",
      causedByEventId: eventId,
      sessionKey: state.sessionKey,
      before: state.done,
      after: done,
      revision,
      reason,
    }),
  };
}

/** Explicit marking is independent of runtime activity, including already busy work. */
export function setCompletion(state: CompletionState, input: SetCompletionInput): CompletionResult {
  if (input.expectedRevision !== undefined && input.expectedRevision !== state.revision) {
    return { state };
  }
  assertSequence(input.executionSequence);
  // An unchanged mark revision does not imply that no newer work has started.
  if (input.expectedRevision !== undefined && input.executionSequence < state.executionSequence) {
    return { state };
  }
  return changeMark(withFrontier(state, input.executionSequence), input.done, input, "manual");
}

function matchesCurrentMark(state: CompletionState, activity: CompletionActivity): boolean {
  const workflow = activity.workflow;
  return Boolean(
    state.done &&
      workflow?.workflowId &&
      workflow.markRevision === state.revision &&
      workflow.causedByEventId === state.markEventId,
  );
}

function defaultDecision(
  state: CompletionState,
  activity: CompletionActivity,
  policy: CompletionPolicy,
): "keep" | "clear" {
  if (policy.mode === "manual" || activity.type !== "execution.started" || !state.done) {
    return "keep";
  }
  if (
    matchesCurrentMark(state, activity) &&
    policy.preserveFor?.includes(activity.workflow!.name)
  ) {
    return "keep";
  }
  return "clear";
}

/**
 * Applies host facts without starting any work. Duplicate/old starts and stale
 * revision-targeted results do not run the policy. Preserved starts still advance
 * the frontier, so replay cannot later turn them into unrelated new work.
 */
export function applyCompletionActivity(
  state: CompletionState,
  activity: CompletionActivity,
  policy: CompletionPolicy = { mode: "on-execution" },
): CompletionResult {
  if (activity.type === "execution.started" || activity.type === "execution.finished") {
    assertExecutionSequence(activity.executionSequence);
  }
  // Expected revisions guard requests/results, not newly confirmed execution facts.
  if (
    activity.type !== "execution.started" &&
    activity.expectedRevision !== undefined &&
    activity.expectedRevision !== state.revision
  ) {
    return { state };
  }
  if (activity.type === "workflow.finished" && !matchesCurrentMark(state, activity)) {
    return { state };
  }

  let next = state;
  if (activity.type === "execution.started") {
    if (activity.executionSequence <= state.executionSequence) return { state };
    next = withFrontier(state, activity.executionSequence);
  } else if (activity.type === "execution.finished") {
    if (activity.executionSequence < state.executionSequence) return { state };
    next = withFrontier(state, activity.executionSequence);
  }

  const fallback = defaultDecision(state, activity, policy);
  let decision: CompletionDecision = fallback;
  let reason: CompletionChange["reason"] = "execution.started";
  if (policy.mode === "custom") {
    try {
      // The static signature rejects async policies; this also defends JS callers.
      const candidate: unknown = policy.decide(
        Object.freeze({
          state: Object.freeze({ ...state }),
          activity: Object.freeze({ ...activity, ...snapshotContext(activity) }),
          defaultDecision: fallback,
        }),
      );
      if (
        candidate !== null &&
        (typeof candidate === "object" || typeof candidate === "function") &&
        "then" in candidate &&
        typeof candidate.then === "function"
      ) {
        // Consume rejections without applying a delayed result to a newer mark.
        void Promise.resolve(candidate).catch(() => undefined);
        return {
          state: next,
          diagnostic: { code: "async-policy", message: "Completion policies must be synchronous" },
        };
      }
      if (
        candidate !== "mark" &&
        candidate !== "clear" &&
        candidate !== "keep" &&
        candidate !== "default"
      ) {
        return {
          state: next,
          diagnostic: {
            code: "invalid-policy-decision",
            message: "Unknown completion policy decision",
          },
        };
      }
      decision = candidate === "default" ? fallback : candidate;
      if (candidate !== "default") reason = "policy";
    } catch (error) {
      return {
        state: next,
        diagnostic: {
          code: "policy-error",
          message: error instanceof Error ? error.message : "Completion policy failed",
        },
      };
    }
  }
  if (decision === "keep") return { state: next };
  return changeMark(next, decision === "mark", activity, reason);
}
