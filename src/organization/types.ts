import type { CompletionState, EventOrigin, SessionKey } from "../core/types";

/** Caller-established stable identities; neither credentials nor inferred local paths. */
export interface OrganizationScope {
  readonly hostId: string;
  readonly projectId: string;
}

/** Only plugin-owned annotations. Native session and activity data stay with the host. */
export interface OrganizationDocument {
  readonly version: 1;
  readonly scope: OrganizationScope;
  /** Monotonic document revision; unrelated to host execution sequences. */
  readonly revision: number;
  readonly pins: readonly SessionKey[];
  readonly later: readonly SessionKey[];
  readonly completionStates: readonly CompletionState[];
  /** Imported marks without execution evidence; automatic policy must preserve them. */
  readonly unreconciled: readonly SessionKey[];
  /** Bounded replay ledger. All mutations also require the observed document revision. */
  readonly recentCommandIds: readonly string[];
}

/** Unpublished experimental migration fixture, not an existing released format. */
export interface LegacyOrganizationDocumentV0 {
  readonly version: 0;
  readonly scope: OrganizationScope;
  readonly revision: number;
  readonly pins: readonly SessionKey[];
  readonly later: readonly SessionKey[];
  readonly completed: readonly SessionKey[];
}

export type DocumentDecodeResult =
  | { readonly status: "valid"; readonly document: OrganizationDocument }
  | { readonly status: "migration-required"; readonly legacy: LegacyOrganizationDocumentV0 }
  | {
      readonly status: "invalid";
      readonly code: "invalid-data" | "unsupported-version" | "scope-mismatch";
      readonly message: string;
    };

export interface StorageOptions {
  readonly signal?: AbortSignal;
}

export type StorageReadResult =
  | { readonly status: "missing" }
  | { readonly status: "loaded"; readonly value: unknown }
  | {
      readonly status: "failed";
      readonly code?: "busy" | "aborted" | "invalid-data" | "io-error";
      readonly message: string;
    };

export type StorageWriteResult =
  | {
      readonly status: "written";
      /** Replacement completed. This does not promise crash or power-loss durability. */
      readonly acknowledgement: "atomic-replace";
      readonly diagnostic?: string;
    }
  | { readonly status: "conflict" }
  | {
      readonly status: "failed";
      readonly code?: "busy" | "aborted" | "invalid-data" | "io-error";
      readonly message: string;
    }
  | { readonly status: "unknown"; readonly message: string };

export interface StoragePort {
  read(scope: OrganizationScope, options?: StorageOptions): Promise<StorageReadResult>;
  /**
   * Compare and replacement are serialized across cooperating writers. Null matches
   * only a missing document. Next revision is (expectedRevision ?? 0) + 1. Invalid
   * existing data or unknown versions must never be treated as an empty document.
   */
  compareAndSwap(
    scope: OrganizationScope,
    expectedRevision: number | null,
    next: OrganizationDocument,
    options?: StorageOptions,
  ): Promise<StorageWriteResult>;
}

export interface OrganizationEventEnvelope {
  readonly version: 1;
  readonly id: string;
  readonly scope: OrganizationScope;
  /** Acknowledged document revision, not a host execution number. */
  readonly revision: number;
  readonly origin: EventOrigin;
  /** Input command identity, distinct from this output event's identity. */
  readonly causationId: string;
  readonly correlationId?: string;
  /** Optional caller-supplied diagnostic timestamp; never used for ordering. */
  readonly occurredAt?: string;
}

export type OrganizationEvent = OrganizationEventEnvelope &
  (
    | {
        readonly type: "session.pin.changed";
        readonly sessionKey: SessionKey;
        readonly sessionId: string;
        readonly before: boolean;
        readonly after: boolean;
        readonly reason: "manual" | "cleanup";
      }
    | {
        readonly type: "session.completion.changed";
        readonly sessionKey: SessionKey;
        readonly sessionId: string;
        readonly before: boolean;
        readonly after: boolean;
        readonly completionRevision: number;
        readonly reason: "manual" | "cleanup";
      }
    | {
        readonly type: "queue.added" | "queue.removed" | "queue.reordered";
        readonly sessionKey?: SessionKey;
        readonly sessionId?: string;
        readonly before: readonly SessionKey[];
        readonly after: readonly SessionKey[];
        readonly reason: "manual" | "cleanup";
      }
  );
