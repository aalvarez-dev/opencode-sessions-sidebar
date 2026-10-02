import { describe, expect, test } from "bun:test";
import type { SessionRecord, SessionSummary } from "../src/adapters/opencode-v1/types";
import { createOrganizationDocument, organizationSessionKey } from "../src/organization/schema";
import type { OrganizationDocument } from "../src/organization/types";
import {
  buildGroups,
  createGroupBuilder,
  createSidebarModelBuilder,
  safeLabel,
  statusText,
} from "../src/ui/model";

const scope = { hostId: "example-host", projectId: "example-project" };
const key = (id: string) => organizationSessionKey(scope, id);

function session(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id,
    key: key(id),
    title: `Session ${id}`,
    directory: "/example/project",
    projectId: scope.projectId,
    workspaceId: null,
    parentId: null,
    activity: "idle",
    permissions: 0,
    questions: 0,
    updatedAt: 1,
    ...overrides,
  };
}

function document(overrides: Partial<OrganizationDocument> = {}): OrganizationDocument {
  return { ...createOrganizationDocument(scope), ...overrides };
}

const noSummary = () => undefined;
const empty = { busy: 0, retry: 0, unknown: 0, permissions: 0, questions: 0, errors: 0 };

describe("sidebar presentation", () => {
  test("deduplicates by active, Later, pin priority while preserving independent annotations and manual order", () => {
    const input = [session("a", { activity: "busy", updatedAt: 3 }), session("b"), session("c")];
    const organization = document({
      pins: [key("b"), key("missing"), key("a"), key("c")],
      later: [key("a"), key("missing"), key("b")],
      completionStates: [
        {
          sessionKey: key("a"),
          done: true,
          revision: 1,
          executionSequence: 0,
          markEventId: "manual-completion",
        },
      ],
    });
    const before = JSON.stringify(organization);
    const build = createSidebarModelBuilder();
    const initial = build(input, organization, noSummary);
    expect(initial.groups.map((group) => group.title)).toEqual([
      "Later",
      "Pinned sessions",
      "Other sessions",
    ]);
    expect(
      initial.groups.map((group) => [group.id, group.rows.map((row) => row.session.id)]),
    ).toEqual([
      ["later", ["a", "b"]],
      ["pins", ["c"]],
      ["sessions", []],
    ]);
    const selected = build(input, organization, noSummary, "a");
    expect(selected.activeRow).toMatchObject({ done: true, pinned: true, later: true });
    expect(selected.activeRow?.session.activity).toBe("busy");
    expect(statusText(selected.activeRow!.summary)).toBe("busy 1");
    expect(selected.groups[0]!.rows.map((row) => row.session.id)).toEqual(["b"]);
    expect(selected.rows.map((row) => row.session.id)).toEqual(["a", "b", "c"]);
    // Returning from the active session restores the same manual position.
    expect(build(input, organization, noSummary).groups[0]!.rows).toEqual(initial.groups[0]!.rows);
    expect(JSON.stringify(organization)).toBe(before);
    expect(input.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
  });

  test("subagents use parent disclosure while pinned, Later, selected and orphan children remain reachable", () => {
    const sessions = [
      session("parent"),
      session("plain", { parentId: "parent", agent: "reviewer" }),
      session("pinned", { parentId: "parent" }),
      session("later", { parentId: "parent" }),
      session("selected", { parentId: "plain" }),
      session("orphan", { parentId: "missing" }),
    ];
    const model = createSidebarModelBuilder()(
      sessions,
      document({ pins: [key("pinned")], later: [key("later")] }),
      noSummary,
      "selected",
    );
    expect(model.activeRow?.session.id).toBe("selected");
    expect(model.groups.map((group) => group.rows.map((row) => row.session.id))).toEqual([
      ["later"],
      ["pinned"],
      ["orphan", "parent"],
    ]);
    expect(model.childrenFor("parent").map((row) => row.session.id)).toEqual([
      "later",
      "pinned",
      "plain",
    ]);
    expect(model.childrenFor("plain").map((row) => row.session.id)).toEqual(["selected"]);
    expect(model.childrenFor("missing")).toEqual([]);
    expect(model.rows).toHaveLength(6);
    expect(model.childrenFor("parent")[2]!.session.agent).toBe("reviewer");
  });

  test("parent and collapsed group summaries retain descendant attention and errors without double-counting", () => {
    const parent = session("parent");
    const child = session("child", {
      parentId: "parent",
      activity: "retry",
      permissions: 2,
      questions: 1,
    });
    const grandchild = session("grandchild", { parentId: "child", error: true });
    const expected = { ...empty, retry: 1, permissions: 2, questions: 1, errors: 1 };
    const model = createSidebarModelBuilder()(
      [parent, child, grandchild],
      document({ later: [parent.key, child.key] }),
      noSummary,
    );
    expect(model.groups[0]!.summary).toEqual(expected);
    expect(model.groups[0]!.rows[0]!.summary).toEqual(expected);
    expect(model.groups[0]!.rows[1]!.summary).toEqual(expected);
    expect(model.groups[2]!.rows).toEqual([]);
    expect(statusText(model.groups[0]!.summary)).toBe(
      "retry 1 · errors 1 · permissions 2 · questions 1",
    );
    expect(model.groups[1]!.summary).toEqual(empty);
  });

  test("live subagent disclosure removes idle branches while preserving completion and unresolved summaries", () => {
    const sessions = [
      session("parent"),
      session("busy", { parentId: "parent", activity: "busy" }),
      session("idle", { parentId: "parent" }),
      session("error", { parentId: "parent", error: true }),
      session("permission", { parentId: "parent", permissions: 1 }),
      session("question", { parentId: "parent", questions: 1 }),
      session("retry", { parentId: "parent", activity: "retry" }),
      session("unknown", { parentId: "parent", activity: "unknown" }),
    ];
    const organization = document({
      completionStates: ["busy", "permission", "idle"].map((id) => ({
        sessionKey: key(id),
        done: true,
        revision: 1,
        executionSequence: 0,
        markEventId: `manual-${id}`,
      })),
    });
    const build = createSidebarModelBuilder();
    const model = build(sessions, organization, noSummary, "parent");
    expect(model.childrenFor("parent")).toHaveLength(7);
    expect(model.liveChildrenFor("parent").map((row) => row.session.id)).toEqual([
      "busy",
      "permission",
      "question",
      "retry",
      "unknown",
    ]);
    expect(model.liveChildrenFor("parent")[0]!.done).toBe(true);
    expect(model.activeRow!.summary).toEqual({
      busy: 1,
      retry: 1,
      unknown: 1,
      permissions: 1,
      questions: 1,
      errors: 1,
    });
    const stopped = build(
      sessions.map((entry) => ({ ...entry, activity: "idle", permissions: 0, questions: 0 })),
      organization,
      noSummary,
      "parent",
    );
    expect(stopped.liveChildrenFor("parent")).toEqual([]);
    expect(stopped.activeRow!.summary.errors).toBe(1);
    expect(stopped.childrenFor("parent")).toHaveLength(7);
    expect(stopped.rows).toHaveLength(sessions.length);
    expect(stopped.liveChildrenFor("missing")).toEqual([]);
  });

  test("idle intermediary subagents keep live and attention descendants reachable", () => {
    const build = createSidebarModelBuilder();
    const parent = session("parent");
    const intermediary = session("bridge", { parentId: "parent" });
    const leaf = session("leaf", { parentId: "bridge", activity: "busy" });
    const model = build([parent, intermediary, leaf], null, noSummary);
    expect(model.liveChildrenFor("parent").map((row) => row.session.id)).toEqual(["bridge"]);
    expect(model.liveChildrenFor("bridge").map((row) => row.session.id)).toEqual(["leaf"]);
    const attention = build(
      [parent, intermediary, { ...leaf, activity: "idle", questions: 1 }],
      null,
      noSummary,
    );
    expect(attention.liveChildrenFor("parent")).toHaveLength(1);
    expect(attention.liveChildrenFor("bridge")).toHaveLength(1);
    const finished = build(
      [parent, intermediary, { ...leaf, activity: "idle", error: true }],
      null,
      noSummary,
    );
    expect(finished.liveChildrenFor("parent")).toEqual([]);
    expect(finished.liveChildrenFor("bridge")).toEqual([]);
    expect(finished.groups[2]!.summary.errors).toBe(1);
  });

  test("malformed parent cycles and self references have deterministic reachable roots and bounded summaries", () => {
    const a = session("a", { parentId: "b", activity: "busy", questions: 1 });
    const b = session("b", { parentId: "a", activity: "unknown", permissions: 1 });
    const self = session("self", { parentId: "self", error: true });
    const build = createSidebarModelBuilder();
    const model = build([b, self, a], null, noSummary);
    expect(model.groups[2]!.rows.map((row) => row.session.id)).toEqual(["a", "self"]);
    expect(model.childrenFor("a").map((row) => row.session.id)).toEqual(["b"]);
    expect(model.childrenFor("b")).toEqual([]);
    expect(model.childrenFor("self")).toEqual([]);
    expect(model.groups[2]!.summary).toEqual({
      busy: 1,
      retry: 0,
      unknown: 1,
      permissions: 1,
      questions: 1,
      errors: 1,
    });
    expect(build([a, self, b], null, noSummary).groups).toEqual(model.groups);
    expect(build([a, b], document({ pins: [a.key, b.key] }), noSummary).groups[1]!.summary).toEqual(
      {
        busy: 1,
        retry: 0,
        unknown: 1,
        permissions: 1,
        questions: 1,
        errors: 0,
      },
    );
  });

  test("title order is deterministic for matching timestamps and does not require organization", () => {
    const input = [session("z"), session("b", { updatedAt: 2 }), session("a")];
    const forward = buildGroups(input, null, noSummary);
    const reverse = buildGroups([...input].reverse(), null, noSummary);
    expect(forward).toEqual(reverse);
    expect(forward[0]!.rows).toEqual([]);
    expect(forward[1]!.rows).toEqual([]);
    expect(forward[2]!.rows.map((row) => row.session.id)).toEqual(["b", "a", "z"]);
    expect(forward[2]!.rows.every((row) => !row.done && !row.pinned && !row.later)).toBe(true);
  });

  test("cached row identities survive activity bursts while ordering, summaries and hierarchy stay current", () => {
    const build = createSidebarModelBuilder();
    const a = session("a");
    const b = session("b", { updatedAt: 2 });
    const initial = build([a, b], null, noSummary);
    expect(initial.rows.map((row) => row.session.id)).toEqual(["b", "a"]);
    const changed = { ...a, activity: "busy" as const, questions: 1, title: "Fresh title" };
    const organized = document({ pins: [a.key], later: [b.key, a.key] });
    const burst = build([b, changed], organized, noSummary);
    expect(burst.groups).toEqual(buildGroups([changed, b], organized, noSummary));
    expect(burst.rows[1]!.session.title).toBe("Fresh title");
    expect(burst.groups[0]!.summary).toMatchObject({ busy: 1, questions: 1 });
    expect(initial.groups[2]!.summary).toMatchObject({ busy: 0, questions: 0 });
    const next = build([b, changed], organized, noSummary);
    expect(next.rows[0]).toBe(burst.rows[0]);
    expect(next.rows[1]).toBe(burst.rows[1]);
    const retry = { ...changed, activity: "retry" as const };
    const changedRow = build([b, retry], organized, noSummary);
    expect(changedRow.rows[0]).toBe(next.rows[0]);
    expect(changedRow.rows[1]).not.toBe(next.rows[1]);
    const updated = { ...changed, updatedAt: 3 };
    expect(build([b, updated], organized, noSummary).rows.map((row) => row.session.id)).toEqual([
      "a",
      "b",
    ]);
    const child = { ...updated, parentId: "b" };
    const nested = build([b, child], null, noSummary);
    expect(nested.groups[2]!.rows.map((row) => row.session.id)).toEqual(["b"]);
    expect(nested.childrenFor("b")[0]!.session).toBe(child);
    expect(nested.rows[1]).not.toBe(changedRow.rows[0]); // Parent summary now includes a busy child.
    expect(build([], organized, noSummary).rows).toEqual([]);
    expect(build([a], null, noSummary).rows[0]!.session).toBe(a);
    const groupsOnly = createGroupBuilder();
    expect(groupsOnly([a, b], null, noSummary)).toEqual(buildGroups([a, b], null, noSummary));
  });

  test("unknown activity and partial attention cannot become confirmed idle or clear attention", () => {
    const uncertain: SessionSummary = {
      busy: 1,
      retry: 0,
      unknown: 2,
      permissions: 1,
      questions: 3,
    };
    expect(statusText(uncertain, "partial")).toBe(
      "busy 1 · status ? 2 · permissions 1 · questions 3 · attention partial",
    );
    expect(statusText({ ...empty, unknown: 1 })).toBe("status ? 1");
    expect(statusText(empty, "unknown")).toBe("idle · attention ?");
    expect(statusText({ ...empty, errors: 1 })).toBe("errors 1");
  });

  test("sanitizes terminal controls, line breaks and bidi overrides without splitting Unicode", () => {
    const dirty = "\u001b\u0000  Review\n\tpermissions\u202e\u2066\u009b  ";
    expect(safeLabel(dirty)).toBe("Review permissions");
    expect(safeLabel("\n\u202e\u0000")).toBe("Untitled session");
    expect(safeLabel("🚀".repeat(170))).toBe(`${"🚀".repeat(159)}…`);
    expect(safeLabel("A short title")).toBe("A short title");
  });
});
