import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { Event } from "@opencode-ai/sdk/v2";

/** The live client property must remain a getter when supplied by the host. */
export interface V1HostPort {
  readonly client: {
    readonly session: Pick<
      TuiPluginApi["client"]["session"],
      "list" | "status" | "create" | "update" | "delete"
    >;
    readonly permission: Pick<TuiPluginApi["client"]["permission"], "list">;
    readonly question: Pick<TuiPluginApi["client"]["question"], "list">;
  };
  readonly event: TuiPluginApi["event"];
  readonly lifecycle: TuiPluginApi["lifecycle"];
  readonly route: Pick<TuiPluginApi["route"], "current" | "navigate">;
}

// Compile-only compatibility check against the actual published host contract.
type Assert<T extends true> = T;
export type PublicHostCompatibility = Assert<TuiPluginApi extends V1HostPort ? true : false>;

/** Fixed per adapter instance; dispose and recreate when the host scope changes. */
export interface V1Scope {
  readonly hostId: string;
  readonly projectId: string;
  readonly directory: string;
  readonly workspaceId?: string;
}

export interface V1Limits {
  readonly maxSessions?: number;
  readonly maxAttention?: number;
  readonly maxEventIds?: number;
  readonly maxBufferedEvents?: number;
  readonly requestTimeoutMs?: number;
}

export type Activity = "unknown" | "idle" | "busy" | "retry";

export interface SessionRecord {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly directory: string;
  readonly projectId: string;
  readonly workspaceId: string | null;
  readonly parentId: string | null;
  /** Public host-reported agent name, when available. */
  readonly agent?: string;
  readonly activity: Activity;
  /** Observed non-abort error with confirmed idle, within this connection. */
  readonly error?: boolean;
  readonly permissions: number;
  readonly questions: number;
  readonly updatedAt: number;
}

/** Includes the selected session and every known descendant, each counted once. */
export interface SessionSummary {
  readonly busy: number;
  readonly retry: number;
  readonly unknown: number;
  readonly permissions: number;
  readonly questions: number;
  readonly errors?: number;
}

export interface AdapterState {
  readonly phase: "idle" | "loading" | "ready" | "stale" | "error" | "disposed";
  /** A bounded snapshot read is in progress; unknown alone is not checking. */
  readonly refreshing?: boolean;
  readonly partial: boolean;
  readonly attentionCoverage: "unknown" | "complete" | "partial";
  readonly selectedSessionId: string | null;
  readonly executionCorrelation: "unavailable";
  readonly diagnostic: string | null;
  readonly sessionCount: number;
  readonly attentionCount: number;
  readonly eventIdCount: number;
}

export interface AdapterChange {
  readonly sessionIds: readonly string[];
  readonly stateChanged: boolean;
}

export interface ActionResult {
  readonly status: "succeeded" | "failed" | "unknown" | "requested";
  readonly sessionId?: string;
  readonly message?: string;
}

export type V1Event = Extract<
  Event,
  {
    type:
      | "session.created"
      | "session.updated"
      | "session.deleted"
      | "session.status"
      | "session.error"
      | "permission.asked"
      | "permission.replied"
      | "question.asked"
      | "question.replied"
      | "question.rejected"
      | "server.connected"
      | "server.instance.disposed";
  }
>;
