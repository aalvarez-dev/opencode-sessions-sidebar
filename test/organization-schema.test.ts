import { describe, expect, test } from "bun:test";
import {
  createOrganizationDocument,
  decodeOrganizationDocument,
  migrateOrganizationV0,
  ORGANIZATION_LIMITS,
  organizationSessionKey,
  sessionIdFromKey,
} from "../src/organization/schema";

const scope = { hostId: "example-host", projectId: "example-project" };
const key = (id: string) => organizationSessionKey(scope, id);

function document() {
  return {
    version: 1,
    scope: { ...scope },
    revision: 3,
    pins: [key("session-a")],
    later: [key("session-b"), key("session-a")],
    completionStates: [
      {
        sessionKey: key("session-a"),
        done: true,
        revision: 1,
        executionSequence: 0,
        markEventId: "manual-mark-a",
      },
    ],
    unreconciled: [] as string[],
    recentCommandIds: ["manual-mark-a"],
  };
}

describe("organization persistence schema", () => {
  test("canonical keys distinguish scope and delimiters without consulting local paths", () => {
    const identity = organizationSessionKey({ hostId: "host/one", projectId: "p:one" }, "s/one");
    expect(identity).toBe('["host/one","p:one","s/one"]');
    expect(sessionIdFromKey({ hostId: "host/one", projectId: "p:one" }, identity)).toBe("s/one");
    expect(() => sessionIdFromKey(scope, identity)).toThrow();
    expect(() => sessionIdFromKey(scope, '[ "example-host", "example-project", "s" ]')).toThrow();
  });

  test("decoding returns a detached immutable annotation snapshot", () => {
    const input = document();
    const decoded = decodeOrganizationDocument(input, scope);
    expect(decoded.status).toBe("valid");
    if (decoded.status !== "valid") throw new Error("Expected a valid document");
    input.scope.hostId = "changed";
    input.pins.length = 0;
    input.completionStates[0]!.done = false;
    expect(decoded.document.scope).toEqual(scope);
    expect(decoded.document.pins).toEqual([key("session-a")]);
    expect(decoded.document.completionStates[0]!.done).toBe(true);
    for (const value of [
      decoded.document,
      decoded.document.scope,
      decoded.document.pins,
      decoded.document.later,
      decoded.document.completionStates,
      decoded.document.completionStates[0],
      decoded.document.unreconciled,
      decoded.document.recentCommandIds,
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
  });

  test("unknown versions and foreign scope fail closed instead of creating empty state", () => {
    expect(decodeOrganizationDocument({ ...document(), version: 2 }, scope)).toMatchObject({
      status: "invalid",
      code: "unsupported-version",
    });
    expect(
      decodeOrganizationDocument(document(), { ...scope, hostId: "another-host" }),
    ).toMatchObject({
      status: "invalid",
      code: "scope-mismatch",
    });
    expect(
      decodeOrganizationDocument(
        {
          ...document(),
          pins: [organizationSessionKey({ ...scope, projectId: "another-project" }, "s")],
        },
        scope,
      ),
    ).toMatchObject({
      status: "invalid",
      code: "scope-mismatch",
    });
  });

  test("rejects duplicate identities, native state, unsafe revisions, and inconsistent mark causality", () => {
    const base = document();
    const malformed = [
      { ...base, pins: [key("a"), key("a")] },
      { ...base, later: [key("a"), key("a")] },
      { ...base, completionStates: [...base.completionStates, ...base.completionStates] },
      { ...base, recentCommandIds: ["same", "same"] },
      { ...base, activity: "busy" },
      { ...base, revision: Number.MAX_SAFE_INTEGER + 1 },
      { ...base, revision: -1 },
      { ...base, revision: 0.5 },
      { ...base, revision: 0 },
      { ...base, completionStates: [{ ...base.completionStates[0], executionSequence: Infinity }] },
      { ...base, completionStates: [{ ...base.completionStates[0], markEventId: null }] },
      { ...base, completionStates: [{ ...base.completionStates[0], done: false }] },
      { ...base, unreconciled: [key("missing")] },
    ];
    for (const input of malformed)
      expect(decodeOrganizationDocument(input, scope).status).toBe("invalid");
  });

  test("enforces array, identifier, dedup, distinct-session, and encoded-byte bounds", () => {
    const empty = createOrganizationDocument(scope);
    expect(
      decodeOrganizationDocument(
        {
          ...empty,
          pins: Array.from({ length: ORGANIZATION_LIMITS.maxEntries + 1 }, (_, i) => key(`s${i}`)),
        },
        scope,
      ).status,
    ).toBe("invalid");
    expect(
      decodeOrganizationDocument(
        { ...empty, recentCommandIds: Array.from({ length: 257 }, (_, i) => `command-${i}`) },
        scope,
      ).status,
    ).toBe("invalid");
    expect(() => key("x".repeat(ORGANIZATION_LIMITS.maxIdLength + 1))).toThrow();
    expect(() => key("line\nbreak")).toThrow();
    const pins = Array.from({ length: 3_000 }, (_, i) => key(`pin-${i}`));
    const later = Array.from({ length: 3_000 }, (_, i) => key(`later-${i}`));
    expect(decodeOrganizationDocument({ ...empty, pins, later }, scope).status).toBe("invalid");
    const largePins = Array.from({ length: 3_000 }, (_, i) => key(`${i}${"\u4e2d".repeat(200)}`));
    expect(decodeOrganizationDocument({ ...empty, pins: largePins }, scope).status).toBe("invalid");
  });

  test("untrusted accessors, sparse arrays, and custom iterators are rejected without invoking them", () => {
    let calls = 0;
    const input = document();
    Object.defineProperty(input, "revision", {
      enumerable: true,
      get() {
        calls++;
        return 3;
      },
    });
    expect(decodeOrganizationDocument(input, scope).status).toBe("invalid");
    const pins = [key("a")];
    Object.defineProperty(pins, "0", {
      enumerable: true,
      get() {
        calls++;
        return key("a");
      },
    });
    expect(decodeOrganizationDocument({ ...document(), pins }, scope).status).toBe("invalid");
    const iterable = [key("a")];
    iterable[Symbol.iterator] = function* () {
      calls++;
      while (true) yield key("a");
    };
    expect(decodeOrganizationDocument({ ...document(), pins: iterable }, scope).status).toBe(
      "invalid",
    );
    expect(decodeOrganizationDocument({ ...document(), pins: Array(1) }, scope).status).toBe(
      "invalid",
    );
    expect(calls).toBe(0);
  });

  test("legacy fixture migration is explicit and preserves marks without inventing causality", () => {
    const legacy = {
      version: 0,
      scope,
      revision: 7,
      pins: [key("a")],
      later: [key("b"), key("a")],
      completed: [key("a")],
    };
    const decoded = decodeOrganizationDocument(legacy, scope);
    expect(decoded.status).toBe("migration-required");
    const migrated = migrateOrganizationV0(legacy, scope);
    expect(migrated.revision).toBe(7);
    expect(migrated.pins).toEqual(legacy.pins);
    expect(migrated.later).toEqual(legacy.later);
    expect(migrated.completionStates).toEqual([
      {
        sessionKey: key("a"),
        done: true,
        revision: 0,
        executionSequence: 0,
        markEventId: null,
      },
    ]);
    expect(migrated.unreconciled).toEqual([key("a")]);
    expect(migrated.recentCommandIds).toEqual([]);
    expect(decodeOrganizationDocument(migrated, scope).status).toBe("valid");
    legacy.completed.length = 0;
    expect(migrated.unreconciled).toEqual([key("a")]);
    expect(() => migrateOrganizationV0({ ...legacy, version: 3 }, scope)).toThrow();
    expect(
      decodeOrganizationDocument(
        {
          ...migrated,
          completionStates: [{ ...migrated.completionStates[0], executionSequence: 1 }],
        },
        scope,
      ).status,
    ).toBe("invalid");
  });
});
