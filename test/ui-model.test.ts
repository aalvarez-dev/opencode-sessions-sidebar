import { describe, expect, test } from "bun:test";
import type { SessionRecord, SessionSummary } from "../src/adapters/opencode-v1/types";
import { createOrganizationDocument, organizationSessionKey } from "../src/organization/schema";
import type { OrganizationDocument } from "../src/organization/types";
import { buildGroups, createGroupBuilder, safeLabel, statusText } from "../src/ui/model";

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

describe("sidebar presentation", () => {
  test("preserves independent marks, pins and Later order without cleaning missing references", () => {
    const input = [session("a", { activity: "busy", updatedAt: 3 }), session("b")];
    const organization = document({
      pins: [key("b"), key("missing"), key("a")],
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
    const groups = buildGroups(input, organization, noSummary);
    expect(groups.map((group) => group.title)).toEqual(["Pinned", "Later", "All sessions"]);
    expect(groups.map((group) => [group.id, group.rows.map((row) => row.session.id)])).toEqual([
      ["pins", ["b", "a"]],
      ["later", ["a", "b"]],
      ["sessions", ["a", "b"]],
    ]);
    for (const group of groups) {
      const marked = group.rows.find((row) => row.session.id === "a")!;
      expect(marked).toMatchObject({ done: true, pinned: true, later: true });
      expect(marked.session.activity).toBe("busy");
      expect(statusText(marked.summary)).toBe("busy 1");
    }
    expect(JSON.stringify(organization)).toBe(before);
    expect(input.map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  test("parent and collapsed group summaries retain descendant attention without double-counting", () => {
    const parent = session("parent");
    const child = session("child", {
      parentId: "parent",
      activity: "retry",
      permissions: 2,
      questions: 1,
    });
    const grandchild = session("grandchild", { parentId: "child", activity: "busy" });
    const aggregate: SessionSummary = {
      busy: 1,
      retry: 1,
      unknown: 0,
      permissions: 2,
      questions: 1,
    };
    const groups = buildGroups(
      [parent, child, grandchild],
      document({ pins: [parent.key], later: [parent.key, child.key] }),
      (id) => (id === "parent" || id === "child" ? aggregate : undefined),
    );
    expect(groups[0]!.rows).toHaveLength(1);
    expect(groups[0]!.rows[0]!.summary).toEqual(aggregate);
    for (const group of groups) expect(group.summary).toEqual(aggregate);
    expect(statusText(groups[0]!.summary)).toBe("busy 1 · retry 1 · permissions 2 · questions 1");
  });

  test("malformed parent cycles remain bounded and each session contributes only once", () => {
    const a = session("a", { parentId: "b", activity: "busy", questions: 1 });
    const b = session("b", { parentId: "a", activity: "unknown", permissions: 1 });
    const groups = buildGroups([a, b], document({ pins: [a.key, b.key] }), noSummary);
    expect(groups[0]!.summary).toEqual({
      busy: 1,
      retry: 0,
      unknown: 1,
      permissions: 1,
      questions: 1,
    });
    expect(groups[2]!.summary).toEqual(groups[0]!.summary);
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

  test("cached order keeps fresh facts and invalidates when membership or timestamps change", () => {
    const build = createGroupBuilder();
    const a = session("a");
    const b = session("b", { updatedAt: 2 });
    const initial = build([a, b], null, noSummary);
    expect(initial[2]!.rows.map((row) => row.session.id)).toEqual(["b", "a"]);

    const changed = { ...a, activity: "busy" as const, questions: 1, title: "Fresh title" };
    const organized = document({ pins: [a.key], later: [b.key, a.key] });
    const burst = build([b, changed], organized, noSummary);
    expect(burst).toEqual(buildGroups([changed, b], organized, noSummary));
    expect(burst[2]!.rows[1]!.session.title).toBe("Fresh title");
    expect(burst[2]!.summary).toMatchObject({ busy: 1, questions: 1 });
    expect(initial[2]!.summary).toMatchObject({ busy: 0, questions: 0 });

    const next = build([b, changed], organized, noSummary);
    expect(next[2]!.rows[0]).toBe(burst[2]!.rows[0]);
    expect(next[2]!.rows[1]).toBe(burst[2]!.rows[1]);
    const active = { ...changed, activity: "retry" as const };
    const changedRow = build([b, active], organized, noSummary);
    expect(changedRow[2]!.rows[0]).toBe(next[2]!.rows[0]);
    expect(changedRow[2]!.rows[1]).not.toBe(next[2]!.rows[1]);

    const updated = { ...changed, updatedAt: 3 };
    expect(build([b, updated], organized, noSummary)[2]!.rows.map((row) => row.session.id)).toEqual(
      ["a", "b"],
    );
    const c = session("c", { updatedAt: 4 });
    expect(build([b, c], organized, noSummary)).toEqual(buildGroups([b, c], organized, noSummary));
    expect(build([], organized, noSummary)).toEqual(buildGroups([], organized, noSummary));
    expect(build([a], null, noSummary)[2]!.rows.map((row) => row.session.id)).toEqual(["a"]);
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
    expect(statusText({ busy: 0, retry: 0, unknown: 1, permissions: 0, questions: 0 })).toBe(
      "status ? 1",
    );
    expect(
      statusText({ busy: 0, retry: 0, unknown: 0, permissions: 0, questions: 0 }, "unknown"),
    ).toBe("idle · attention ?");
  });

  test("sanitizes terminal controls, line breaks and bidi overrides without splitting Unicode", () => {
    const dirty = "\u001b\u0000  Review\n\tpermissions\u202e\u2066\u009b  ";
    expect(safeLabel(dirty)).toBe("Review permissions");
    expect(safeLabel("\n\u202e\u0000")).toBe("Untitled session");
    expect(safeLabel("🚀".repeat(170))).toBe(`${"🚀".repeat(159)}…`);
    expect(safeLabel("A short title")).toBe("A short title");
  });
});
