/** A host-scoped session identity, including the server/instance when needed. */
export type SessionKey = string;

export type EventOrigin =
  | { readonly type: "user" }
  | { readonly type: "host" }
  | { readonly type: "extension"; readonly id: string }
  | { readonly type: "unknown" };

/** Facts supplied by the host, never inferred from a busy status or timing. */
export interface WorkflowCorrelation {
  readonly workflowId: string;
  readonly name: string;
  /** Input that established the mark, equal to its change.causedByEventId. */
  readonly causedByEventId: string;
  readonly markRevision: number;
}

export interface CompletionState {
  readonly sessionKey: SessionKey;
  readonly done: boolean;
  /** Changes only when the visual mark changes. */
  readonly revision: number;
  /**
   * Highest confirmed execution sequence observed or acknowledged at marking.
   * Zero is the reserved frontier before any execution. Execution events are
   * 1-based. The host must supply a reliable per-session monotonic sequence and
   * reconcile it across restarts. A clock, busy snapshot, or reset counter is
   * not enough.
   */
  readonly executionSequence: number;
  /** Input that established the mark, not an ID assigned by a future event dispatcher. */
  readonly markEventId: string | null;
}

export interface CompletionEventContext {
  readonly eventId: string;
  readonly origin: EventOrigin;
  readonly workflow?: WorkflowCorrelation;
  /** Guards explicit requests and results; it never suppresses a new execution fact. */
  readonly expectedRevision?: number;
}

export interface SetCompletionInput extends CompletionEventContext {
  readonly done: boolean;
  /** Current confirmed frontier, including work in flight; 0 before any execution. */
  readonly executionSequence: number;
}

export type CompletionActivity = CompletionEventContext &
  (
    | {
        /** Only emit for a confirmed new execution, not a busy observation. */
        readonly type: "execution.started";
        /** Positive safe integer; 0 is reserved for the pre-execution frontier. */
        readonly executionSequence: number;
      }
    | {
        readonly type: "execution.finished";
        /** Positive safe integer, using the same 1-based sequence as its start. */
        readonly executionSequence: number;
        /** Captured before the work; late results cannot overwrite a new mark. */
        readonly expectedRevision: number;
      }
    | {
        readonly type: "workflow.finished";
        readonly workflow: WorkflowCorrelation;
        readonly expectedRevision: number;
      }
    | {
        /** Observations alone never cause an automatic completion change. */
        readonly type: "runtime.observed";
        readonly status: "busy" | "idle" | "unknown";
        readonly expectedRevision: number;
      }
  );

export type CompletionDecision = "mark" | "clear" | "keep" | "default";

export interface CompletionPolicyContext {
  /** Immutable snapshot before this activity; its frontier has not advanced yet. */
  readonly state: Readonly<CompletionState>;
  /** Incoming fact; accepted execution evidence advances the returned state frontier. */
  readonly activity: Readonly<CompletionActivity>;
  readonly defaultDecision: Exclude<CompletionDecision, "default">;
}

export type CompletionPolicy =
  | { readonly mode: "manual" }
  | {
      readonly mode: "on-execution";
      /** Workflow names; preservation also requires exact causal correlation. */
      readonly preserveFor?: readonly string[];
    }
  | {
      readonly mode: "custom";
      readonly preserveFor?: readonly string[];
      /** Pure synchronous decision. Side effects belong in separate hooks. */
      readonly decide: (context: CompletionPolicyContext) => CompletionDecision;
    };

export interface CompletionChange extends Omit<CompletionEventContext, "eventId"> {
  readonly type: "completion.changed";
  /** Input identity causing this change, not a unique identity for the output. */
  readonly causedByEventId: string;
  readonly sessionKey: SessionKey;
  readonly before: boolean;
  readonly after: boolean;
  readonly revision: number;
  readonly reason: "manual" | "execution.started" | "policy";
}

export interface CompletionResult {
  readonly state: CompletionState;
  readonly change?: CompletionChange;
  /** A broken custom policy leaves the visual mark unchanged. */
  readonly diagnostic?: {
    readonly code: "policy-error" | "async-policy" | "invalid-policy-decision";
    readonly message: string;
  };
}

export interface QueueChange {
  readonly type: "queue.changed";
  readonly action: "added" | "removed" | "reordered";
  readonly before: readonly SessionKey[];
  readonly after: readonly SessionKey[];
  readonly sessionKey?: SessionKey;
}

export interface QueueResult {
  readonly queue: readonly SessionKey[];
  readonly change?: QueueChange;
}
