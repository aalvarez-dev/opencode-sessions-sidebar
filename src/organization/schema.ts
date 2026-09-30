import type { CompletionState, SessionKey } from "../core/types";
import type {
  DocumentDecodeResult,
  LegacyOrganizationDocumentV0,
  OrganizationDocument,
  OrganizationScope,
} from "./types";

/** Format limits, not a promise to retain arbitrarily large histories. */
export const ORGANIZATION_LIMITS = Object.freeze({
  maxEntries: 5_000,
  maxIdLength: 512,
  maxEventIdLength: 1_024,
  maxRecentCommandIds: 256,
  maxDocumentBytes: 1_048_576,
});

type InvalidCode = Extract<DocumentDecodeResult, { status: "invalid" }>["code"];

class SchemaError extends RangeError {
  constructor(
    message: string,
    readonly code: InvalidCode = "invalid-data",
  ) {
    super(message);
  }
}

function invalid(message: string, code?: InvalidCode): never {
  throw new SchemaError(message, code);
}

function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid("Expected a JSON object");
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return invalid("Expected a plain JSON object");
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  ) {
    return invalid("Unexpected or missing object fields");
  }
  const detached: Record<string, unknown> = Object.create(null);
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      return invalid("Expected ordinary JSON fields");
    }
    detached[field] = descriptor.value;
  }
  return detached;
}

function identifier(value: unknown, maximum: number = ORGANIZATION_LIMITS.maxIdLength): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim().length === 0 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return invalid("Expected a bounded non-empty identifier without control characters");
  }
  return value;
}

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return invalid("Expected a non-negative safe integer");
  }
  return value;
}

export function validateOrganizationScope(value: unknown): OrganizationScope {
  const data = record(value, ["hostId", "projectId"]);
  return Object.freeze({ hostId: identifier(data.hostId), projectId: identifier(data.projectId) });
}

function matchingScope(value: unknown, expected: OrganizationScope): OrganizationScope {
  const scope = validateOrganizationScope(value);
  if (scope.hostId !== expected.hostId || scope.projectId !== expected.projectId) {
    return invalid(
      "Stored organization scope does not match the requested scope",
      "scope-mismatch",
    );
  }
  return scope;
}

export function organizationSessionKey(scope: OrganizationScope, sessionId: string): SessionKey {
  const checked = validateOrganizationScope(scope);
  return JSON.stringify([checked.hostId, checked.projectId, identifier(sessionId)]);
}

function decodeKey(scope: OrganizationScope, key: unknown): string {
  if (typeof key !== "string" || key.length > ORGANIZATION_LIMITS.maxIdLength * 18 + 10) {
    return invalid("Expected a bounded canonical session key");
  }
  let tuple: unknown;
  try {
    tuple = JSON.parse(key);
  } catch {
    return invalid("Session key is not a JSON identity tuple");
  }
  if (!Array.isArray(tuple) || tuple.length !== 3) {
    return invalid("Session key must contain host, project, and session identities");
  }
  const hostId = identifier(tuple[0]);
  const projectId = identifier(tuple[1]);
  const sessionId = identifier(tuple[2]);
  if (hostId !== scope.hostId || projectId !== scope.projectId) {
    return invalid("Session key belongs to a different scope", "scope-mismatch");
  }
  if (JSON.stringify([hostId, projectId, sessionId]) !== key) {
    return invalid("Session key is not in canonical form");
  }
  return sessionId;
}

export function sessionIdFromKey(scope: OrganizationScope, key: SessionKey): string {
  return decodeKey(validateOrganizationScope(scope), key);
}

function stringList(
  value: unknown,
  validate: (item: unknown) => string,
  maximum: number = ORGANIZATION_LIMITS.maxEntries,
): readonly string[] {
  const items = jsonArray(value, maximum);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const entry = validate(item);
    if (seen.has(entry)) return invalid("Duplicate array identity");
    seen.add(entry);
    result.push(entry);
  }
  return Object.freeze(result);
}

function jsonArray(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    return invalid("Expected a bounded JSON array");
  }
  const length = value.length;
  if (Reflect.ownKeys(value).length !== length + 1)
    return invalid("Expected ordinary JSON array entries");
  const copy: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      return invalid("Expected ordinary JSON array entries");
    }
    copy.push(descriptor.value);
  }
  return copy;
}

function keyList(value: unknown, scope: OrganizationScope): readonly SessionKey[] {
  return stringList(value, (key) => {
    decodeKey(scope, key);
    return key as string;
  });
}

function completions(value: unknown, scope: OrganizationScope): readonly CompletionState[] {
  const items = jsonArray(value, ORGANIZATION_LIMITS.maxEntries);
  const seen = new Set<string>();
  const entries: CompletionState[] = [];
  for (const item of items) {
    const data = record(item, [
      "sessionKey",
      "done",
      "revision",
      "executionSequence",
      "markEventId",
    ]);
    decodeKey(scope, data.sessionKey);
    const sessionKey = data.sessionKey as string;
    if (seen.has(sessionKey)) return invalid("Duplicate completion-state identity");
    seen.add(sessionKey);
    if (typeof data.done !== "boolean") return invalid("Completion mark must be boolean");
    const markEventId =
      data.markEventId === null
        ? null
        : identifier(data.markEventId, ORGANIZATION_LIMITS.maxEventIdLength);
    if (!data.done && markEventId !== null)
      return invalid("A cleared mark cannot retain a mark event");
    entries.push(
      Object.freeze({
        sessionKey,
        done: data.done,
        revision: integer(data.revision),
        executionSequence: integer(data.executionSequence),
        markEventId,
      }),
    );
  }
  return Object.freeze(entries);
}

/** JSON.stringify escapes unpaired surrogates, so only valid pairs use four UTF-8 bytes. */
function serializedBytes(value: OrganizationDocument | LegacyOrganizationDocumentV0): number {
  const json = JSON.stringify(value);
  let bytes = 0;
  for (let index = 0; index < json.length; index++) {
    const code = json.charCodeAt(index);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index++;
    } else bytes += 3;
  }
  return bytes;
}

function bounded<T extends OrganizationDocument | LegacyOrganizationDocumentV0>(document: T): T {
  const keys = new Set([...document.pins, ...document.later]);
  const completed =
    document.version === 0
      ? document.completed
      : document.completionStates.map((state) => state.sessionKey);
  for (const key of completed) keys.add(key);
  if (keys.size > ORGANIZATION_LIMITS.maxEntries) return invalid("Too many distinct sessions");
  if (serializedBytes(document) > ORGANIZATION_LIMITS.maxDocumentBytes) {
    return invalid("Organization document exceeds the encoded size limit");
  }
  return Object.freeze(document);
}

export function createOrganizationDocument(scope: OrganizationScope): OrganizationDocument {
  return Object.freeze({
    version: 1,
    scope: validateOrganizationScope(scope),
    revision: 0,
    pins: Object.freeze([]),
    later: Object.freeze([]),
    completionStates: Object.freeze([]),
    unreconciled: Object.freeze([]),
    recentCommandIds: Object.freeze([]),
  });
}

/** Validates and detaches values. Unknown versions and invalid data never become empty state. */
export function decodeOrganizationDocument(
  value: unknown,
  expectedScope: OrganizationScope,
): DocumentDecodeResult {
  try {
    const expected = validateOrganizationScope(expectedScope);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return invalid("Expected a JSON document");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, "version");
    if (!descriptor || !("value" in descriptor)) return invalid("Document version is missing");
    if (descriptor.value !== 0 && descriptor.value !== 1) {
      return invalid("Unsupported organization schema version", "unsupported-version");
    }
    if (descriptor.value === 0) {
      const data = record(value, ["version", "scope", "revision", "pins", "later", "completed"]);
      const scope = matchingScope(data.scope, expected);
      const legacy = bounded({
        version: 0 as const,
        scope,
        revision: integer(data.revision),
        pins: keyList(data.pins, scope),
        later: keyList(data.later, scope),
        completed: keyList(data.completed, scope),
      });
      return { status: "migration-required", legacy };
    }
    const data = record(value, [
      "version",
      "scope",
      "revision",
      "pins",
      "later",
      "completionStates",
      "unreconciled",
      "recentCommandIds",
    ]);
    const scope = matchingScope(data.scope, expected);
    const revision = integer(data.revision);
    const completionStates = completions(data.completionStates, scope);
    const unreconciled = keyList(data.unreconciled, scope);
    const imported = new Set(unreconciled);
    for (const state of completionStates) {
      if (state.revision > revision) return invalid("Mark revision exceeds document revision");
      if (imported.has(state.sessionKey)) {
        if (
          !state.done ||
          state.revision !== 0 ||
          state.executionSequence !== 0 ||
          state.markEventId !== null
        ) {
          return invalid("Imported mark contains unconfirmed causal evidence");
        }
        imported.delete(state.sessionKey);
      } else if (state.done && (state.markEventId === null || state.revision === 0)) {
        return invalid("An established mark requires its causal input and mark revision");
      }
    }
    if (imported.size !== 0) return invalid("Unreconciled entries must identify imported marks");
    const document = bounded({
      version: 1 as const,
      scope,
      revision,
      pins: keyList(data.pins, scope),
      later: keyList(data.later, scope),
      completionStates,
      unreconciled,
      recentCommandIds: stringList(
        data.recentCommandIds,
        (id) => identifier(id, ORGANIZATION_LIMITS.maxEventIdLength),
        ORGANIZATION_LIMITS.maxRecentCommandIds,
      ),
    });
    return { status: "valid", document };
  } catch (error) {
    return {
      status: "invalid",
      code: error instanceof SchemaError ? error.code : "invalid-data",
      message: error instanceof SchemaError ? error.message : "Invalid organization document",
    };
  }
}

/**
 * Pure explicit migration of an unpublished fixture. It writes nothing, emits
 * nothing, and does not invent mark event IDs or execution correlation. The caller
 * increments the document revision only when requesting the migration's CAS write.
 */
export function migrateOrganizationV0(
  value: unknown,
  scope: OrganizationScope,
): OrganizationDocument {
  const decoded = decodeOrganizationDocument(value, scope);
  if (decoded.status !== "migration-required") {
    throw new RangeError(
      decoded.status === "invalid" ? decoded.message : "Expected schema version 0",
    );
  }
  const legacy = decoded.legacy;
  return bounded({
    version: 1,
    scope: legacy.scope,
    revision: legacy.revision,
    pins: legacy.pins,
    later: legacy.later,
    completionStates: Object.freeze(
      legacy.completed.map((sessionKey) =>
        Object.freeze({
          sessionKey,
          done: true,
          revision: 0,
          executionSequence: 0,
          markEventId: null,
        }),
      ),
    ),
    unreconciled: legacy.completed,
    recentCommandIds: Object.freeze([]),
  });
}
