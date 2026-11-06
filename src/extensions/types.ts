import type {
  OrganizationAction,
  OrganizationDocument,
  OrganizationEvent,
  OrganizationResult,
  OrganizationScope,
} from "../organization";

/** Explicit trusted local modules. Disabled entries are never imported. */
export interface SidebarExtensionConfig {
  readonly module: string;
  readonly enabled?: boolean;
}

export interface ExtensionSession {
  readonly id: string;
  readonly title: string;
  readonly activity: "unknown" | "idle" | "busy" | "retry";
  readonly permissions: number;
  readonly questions: number;
}

export interface ExtensionSnapshot {
  readonly scope: OrganizationScope;
  readonly session: ExtensionSession | null;
  readonly organization: OrganizationDocument;
}

/** Commands are revoked when the callback settles, times out, or its scope changes. */
export interface ExtensionContext extends ExtensionSnapshot {
  readonly signal: AbortSignal;
  /** Action snapshot revision, or the delivered event revision even if the snapshot is newer. */
  readonly expectedRevision: number;
  /** Await each command. A concurrent change refuses a stale command; no automatic rebase. */
  dispatch(action: OrganizationAction): Promise<OrganizationResult>;
  notify(message: string): void;
}

export interface SidebarExtensionAction {
  /** Local action ID; the host prefixes it with the extension ID. */
  readonly id: string;
  readonly title: string;
  /** Short synchronous predicates; no I/O. Exceptions disable this extension. */
  readonly visible?: (snapshot: ExtensionSnapshot) => boolean;
  readonly enabled?: (snapshot: ExtensionSnapshot) => boolean;
  readonly run: (context: ExtensionContext) => void | Promise<void>;
}

/** Experimental versioned contract, deliberately without execution-correlation promises. */
export interface SidebarExtension {
  readonly apiVersion: 1;
  readonly id: string;
  readonly actions?: readonly SidebarExtensionAction[];
  /** Best-effort committed manual organization events; no hydration replay. */
  readonly onEvent?: (event: OrganizationEvent, context: ExtensionContext) => void | Promise<void>;
}

export interface ExtensionActionEntry {
  readonly id: string;
  readonly title: string;
  readonly extensionId: string;
  readonly enabled: boolean;
}

export interface ExtensionDiagnostic {
  readonly module: string;
  readonly id: string | null;
  readonly state: "disabled" | "loading" | "ready" | "failed";
  readonly message: string | null;
}
