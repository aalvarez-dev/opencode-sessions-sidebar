import type { SessionRecord, SessionSummary } from "../adapters/opencode-v1/types";
import type { OrganizationDocument } from "../organization/types";

export type Density = "compact" | "balanced" | "comfortable";
export type IconMode = "unicode" | "ascii";
export type GroupId = "pins" | "later" | "sessions";

export interface SidebarRow {
  readonly session: SessionRecord;
  readonly done: boolean;
  readonly pinned: boolean;
  readonly later: boolean;
  /** Host summary includes this session and its known descendants. */
  readonly summary: SessionSummary;
}

export interface SidebarGroup {
  readonly id: GroupId;
  readonly title: string;
  readonly rows: readonly SidebarRow[];
  /** Each group member and known descendant contributes its own facts once. */
  readonly summary: SessionSummary;
}

function emptySummary() {
  return { busy: 0, retry: 0, unknown: 0, permissions: 0, questions: 0 };
}

function ownSummary(session: SessionRecord): SessionSummary {
  return {
    busy: Number(session.activity === "busy"),
    retry: Number(session.activity === "retry"),
    unknown: Number(session.activity === "unknown"),
    permissions: session.permissions,
    questions: session.questions,
  };
}

/** Presentation only: missing references are skipped, never removed from storage. */
export function buildGroups(
  sessions: readonly SessionRecord[],
  document: OrganizationDocument | null,
  summary: (id: string) => SessionSummary | undefined,
): readonly SidebarGroup[] {
  const sessionsByKey = new Map(sessions.map((session) => [session.key, session]));
  return renderGroups(sessionsByKey, document, summary, orderedKeys(sessionsByKey));
}

/** Cache only ordering, so activity/attention bursts never sort the complete list. */
export function createGroupBuilder(): typeof buildGroups {
  let timestamps = new Map<string, number>();
  let order: readonly string[] = [];
  const cachedRows = new Map<string, SidebarRow>();
  return (sessions, document, summary) => {
    const sessionsByKey = new Map(sessions.map((session) => [session.key, session]));
    const changed =
      timestamps.size !== sessionsByKey.size ||
      [...sessionsByKey.values()].some(
        (session) => timestamps.get(session.key) !== session.updatedAt,
      );
    if (changed) {
      order = orderedKeys(sessionsByKey);
      timestamps = new Map(
        [...sessionsByKey.values()].map((session) => [session.key, session.updatedAt]),
      );
    }
    for (const key of cachedRows.keys()) if (!sessionsByKey.has(key)) cachedRows.delete(key);
    return renderGroups(sessionsByKey, document, summary, order, cachedRows);
  };
}

function orderedKeys(sessions: ReadonlyMap<string, SessionRecord>): readonly string[] {
  return [...sessions.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((session) => session.key);
}

function renderGroups(
  sessionsByKey: ReadonlyMap<string, SessionRecord>,
  document: OrganizationDocument | null,
  summary: (id: string) => SessionSummary | undefined,
  order: readonly string[],
  cachedRows = new Map<string, SidebarRow>(),
): readonly SidebarGroup[] {
  const pins = new Set(document?.pins);
  const later = new Set(document?.later);
  const completed = new Set(
    document?.completionStates.filter((state) => state.done).map((state) => state.sessionKey),
  );
  const children = new Map<string, SessionRecord[]>();
  const rowsByKey = new Map<string, SidebarRow>();

  for (const session of sessionsByKey.values()) {
    if (session.parentId !== null) {
      const siblings = children.get(session.parentId) ?? [];
      siblings.push(session);
      children.set(session.parentId, siblings);
    }
    const currentSummary = summary(session.id) ?? ownSummary(session);
    const done = completed.has(session.key);
    const pinned = pins.has(session.key);
    const inLater = later.has(session.key);
    const previous = cachedRows.get(session.key);
    const row =
      previous?.session === session &&
      previous.done === done &&
      previous.pinned === pinned &&
      previous.later === inLater &&
      previous.summary.busy === currentSummary.busy &&
      previous.summary.retry === currentSummary.retry &&
      previous.summary.unknown === currentSummary.unknown &&
      previous.summary.permissions === currentSummary.permissions &&
      previous.summary.questions === currentSummary.questions
        ? previous
        : Object.freeze({
            session,
            done,
            pinned,
            later: inLater,
            summary: Object.freeze({ ...currentSummary }),
          });
    rowsByKey.set(session.key, row);
    cachedRows.set(session.key, row);
  }

  function rowsFor(keys: readonly string[]): SidebarRow[] {
    return keys.flatMap((key) => {
      const row = rowsByKey.get(key);
      return row ? [row] : [];
    });
  }

  function group(id: GroupId, title: string, rows: SidebarRow[]): SidebarGroup {
    const total = emptySummary();
    const seen = new Set<string>();
    const pending = rows.map((row) => row.session);
    while (pending.length > 0) {
      const session = pending.pop()!;
      if (seen.has(session.key)) continue;
      seen.add(session.key);
      const own = ownSummary(session);
      // Sum own facts, not already-aggregated parent summaries.
      total.busy += own.busy;
      total.retry += own.retry;
      total.unknown += own.unknown;
      total.permissions += own.permissions;
      total.questions += own.questions;
      pending.push(...(children.get(session.id) ?? []));
    }
    return Object.freeze({
      id,
      title,
      rows: Object.freeze(rows),
      summary: Object.freeze(total),
    });
  }

  return Object.freeze([
    group("pins", "Pinned", rowsFor(document?.pins ?? [])),
    group("later", "Later", rowsFor(document?.later ?? [])),
    group("sessions", "All sessions", rowsFor(order)),
  ]);
}

/** Marks deliberately have no influence on runtime or attention labels. */
export function statusText(
  summary: SessionSummary,
  attentionCoverage: "unknown" | "complete" | "partial" = "complete",
): string {
  const labels: string[] = [];
  if (summary.busy > 0) labels.push(`busy ${summary.busy}`);
  if (summary.retry > 0) labels.push(`retry ${summary.retry}`);
  if (summary.unknown > 0) labels.push(`status ? ${summary.unknown}`);
  if (labels.length === 0) labels.push("idle");
  if (summary.permissions > 0) labels.push(`permissions ${summary.permissions}`);
  if (summary.questions > 0) labels.push(`questions ${summary.questions}`);
  if (attentionCoverage !== "complete")
    labels.push(attentionCoverage === "partial" ? "attention partial" : "attention ?");
  return labels.join(" · ");
}

/** Render host labels on one line without terminal controls or direction overrides. */
export function safeLabel(title: string): string {
  const clean = title
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!clean) return "Untitled session";
  // Bound presentation work without splitting supplementary Unicode characters.
  const characters = Array.from(clean);
  return characters.length > 160 ? `${characters.slice(0, 159).join("")}…` : clean;
}
