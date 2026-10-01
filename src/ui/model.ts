import type { SessionRecord, SessionSummary } from "../adapters/opencode-v1/types";
import type { OrganizationDocument } from "../organization/types";

export type Density = "compact" | "balanced" | "comfortable";
export type IconMode = "unicode" | "ascii" | "nerd";
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

export interface SidebarModel {
  /** All loaded sessions remain available to browsing and native actions. */
  readonly rows: readonly SidebarRow[];
  readonly activeRow: SidebarRow | undefined;
  readonly groups: readonly SidebarGroup[];
  /** A deterministic forest prevents malformed host parent cycles in the renderer. */
  readonly childrenFor: (id: string) => readonly SidebarRow[];
}

type SummaryProvider = (id: string) => SessionSummary | undefined;
const noRows: readonly SidebarRow[] = Object.freeze([]);

function emptySummary() {
  return { busy: 0, retry: 0, unknown: 0, permissions: 0, questions: 0, errors: 0 };
}

/** Presentation only: missing references are skipped, never removed from storage. */
export function buildGroups(
  sessions: readonly SessionRecord[],
  document: OrganizationDocument | null,
  summary: SummaryProvider,
  selectedSessionId: string | null = null,
): readonly SidebarGroup[] {
  return createSidebarModelBuilder()(sessions, document, summary, selectedSessionId).groups;
}

/** Compatibility helper for consumers interested only in display groups. */
export function createGroupBuilder(): typeof buildGroups {
  const build = createSidebarModelBuilder();
  return (sessions, document, summary, selectedSessionId = null) =>
    build(sessions, document, summary, selectedSessionId).groups;
}

/** Cache ordering and row identities across activity/attention bursts. */
export function createSidebarModelBuilder() {
  let timestamps = new Map<string, number>();
  let order: readonly string[] = [];
  let parentIds = new Map<string, string | null>();
  let parents: ReadonlyMap<string, string> = new Map();
  const cachedRows = new Map<string, SidebarRow>();
  return (
    sessions: readonly SessionRecord[],
    document: OrganizationDocument | null,
    summary: SummaryProvider,
    selectedSessionId: string | null = null,
  ): SidebarModel => {
    const sessionsByKey = new Map(sessions.map((session) => [session.key, session]));
    const changed =
      timestamps.size !== sessionsByKey.size ||
      [...sessionsByKey.values()].some(
        (session) => timestamps.get(session.key) !== session.updatedAt,
      );
    if (changed) {
      order = [...sessionsByKey.values()]
        .sort((a, b) => b.updatedAt - a.updatedAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        .map((session) => session.key);
      timestamps = new Map(
        [...sessionsByKey.values()].map((session) => [session.key, session.updatedAt]),
      );
    }
    if (
      parentIds.size !== sessionsByKey.size ||
      sessions.some((session) => parentIds.get(session.key) !== session.parentId)
    ) {
      parentIds = new Map(sessions.map((session) => [session.key, session.parentId]));
      parents = forestParents(sessions);
    }
    for (const key of cachedRows.keys()) if (!sessionsByKey.has(key)) cachedRows.delete(key);
    return renderModel(
      sessionsByKey,
      document,
      summary,
      selectedSessionId,
      order,
      cachedRows,
      parents,
    );
  };
}

/** Break one edge per cycle, keeping every session reachable from a visible root. */
function forestParents(sessions: readonly SessionRecord[]): ReadonlyMap<string, string> {
  const known = new Set(sessions.map((session) => session.id));
  const parents = new Map<string, string>();
  for (const session of sessions)
    if (session.parentId !== null && session.parentId !== session.id && known.has(session.parentId))
      parents.set(session.id, session.parentId);
  const visited = new Set<string>();
  for (const session of sessions) {
    if (visited.has(session.id)) continue;
    const path: string[] = [];
    const positions = new Map<string, number>();
    let current: string | undefined = session.id;
    while (current !== undefined && !visited.has(current)) {
      const position = positions.get(current);
      if (position !== undefined) {
        // Stable regardless of host list order or session recency.
        const root = path.slice(position).reduce((a, b) => (a < b ? a : b));
        parents.delete(root);
        break;
      }
      positions.set(current, path.length);
      path.push(current);
      current = parents.get(current);
    }
    for (const id of path) visited.add(id);
  }
  return parents;
}

function renderModel(
  sessionsByKey: ReadonlyMap<string, SessionRecord>,
  document: OrganizationDocument | null,
  summary: SummaryProvider,
  selectedSessionId: string | null,
  order: readonly string[],
  cachedRows: Map<string, SidebarRow>,
  parents: ReadonlyMap<string, string>,
): SidebarModel {
  const pins = new Set(document?.pins);
  const later = new Set(document?.later);
  const completed = new Set(
    document?.completionStates.filter((state) => state.done).map((state) => state.sessionKey),
  );
  const sessions = [...sessionsByKey.values()];
  const children = new Map<string, SessionRecord[]>();
  const rowsByKey = new Map<string, SidebarRow>();
  for (const session of sessions) {
    if (session.parentId !== null) {
      const siblings = children.get(session.parentId) ?? [];
      siblings.push(session);
      children.set(session.parentId, siblings);
    }
  }

  function aggregate(members: readonly SessionRecord[]): SessionSummary {
    const total = emptySummary();
    const seen = new Set<string>();
    const pending = [...members];
    while (pending.length > 0) {
      const session = pending.pop()!;
      if (seen.has(session.key)) continue;
      seen.add(session.key);
      // Sum own facts, not already-aggregated parent summaries.
      total.busy += Number(session.activity === "busy");
      total.retry += Number(session.activity === "retry");
      total.unknown += Number(session.activity === "unknown");
      total.permissions += session.permissions;
      total.questions += session.questions;
      total.errors += Number(session.error === true);
      pending.push(...(children.get(session.id) ?? []));
    }
    return Object.freeze(total);
  }

  for (const session of sessions) {
    const currentSummary = summary(session.id) ?? aggregate([session]);
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
      previous.summary.questions === currentSummary.questions &&
      (previous.summary.errors ?? 0) === (currentSummary.errors ?? 0)
        ? previous
        : Object.freeze({
            session,
            done,
            pinned,
            later: inLater,
            summary: Object.freeze({ ...currentSummary, errors: currentSummary.errors ?? 0 }),
          });
    rowsByKey.set(session.key, row);
    cachedRows.set(session.key, row);
  }

  const rows = Object.freeze(order.map((key) => rowsByKey.get(key)!));
  const activeRow = rows.find((row) => row.session.id === selectedSessionId);
  const childrenRows = new Map<string, readonly SidebarRow[]>();
  const collectingChildren = new Map<string, SidebarRow[]>();
  for (const row of rows) {
    const parent = parents.get(row.session.id);
    if (parent === undefined) continue;
    const siblings = collectingChildren.get(parent) ?? [];
    siblings.push(row);
    collectingChildren.set(parent, siblings);
  }
  for (const [id, members] of collectingChildren) childrenRows.set(id, Object.freeze(members));

  const claimed = new Set(activeRow ? [activeRow.session.key] : []);
  function claim(keys: readonly string[]): readonly SidebarRow[] {
    const members: SidebarRow[] = [];
    for (const key of keys) {
      const row = rowsByKey.get(key);
      if (!row || claimed.has(key)) continue;
      claimed.add(key);
      members.push(row);
    }
    return Object.freeze(members);
  }
  function group(id: GroupId, title: string, members: readonly SidebarRow[]): SidebarGroup {
    return Object.freeze({
      id,
      title,
      rows: members,
      summary: aggregate(members.map((row) => row.session)),
    });
  }
  const groups = Object.freeze([
    group("later", "Later", claim(document?.later ?? [])),
    group("pins", "Pinned sessions", claim(document?.pins ?? [])),
    group(
      "sessions",
      "Other sessions",
      claim(rows.filter((row) => !parents.has(row.session.id)).map((row) => row.session.key)),
    ),
  ]);
  return Object.freeze({
    rows,
    activeRow,
    groups,
    childrenFor: (id: string) => childrenRows.get(id) ?? noRows,
  });
}

/** Marks deliberately have no influence on runtime or attention labels. */
export function statusText(
  summary: SessionSummary,
  attentionCoverage: "unknown" | "complete" | "partial" = "complete",
): string {
  const labels: string[] = [];
  if (summary.busy > 0) labels.push(`busy ${summary.busy}`);
  if (summary.retry > 0) labels.push(`retry ${summary.retry}`);
  if ((summary.errors ?? 0) > 0) labels.push(`errors ${summary.errors}`);
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
