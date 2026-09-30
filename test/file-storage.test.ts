import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileStorage, fileStoragePaths } from "../src/storage/file";
import {
  createOrganizationDocument,
  decodeOrganizationDocument,
  migrateOrganizationV0,
  organizationSessionKey,
} from "../src/organization/schema";
import type { OrganizationDocument, OrganizationScope } from "../src/organization/types";

const scope: OrganizationScope = { hostId: "example-server", projectId: "example-project" };
const folders: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sidebar-storage-test-"));
  folders.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function document(revision = 1, id = "first", valueScope = scope): OrganizationDocument {
  const key = organizationSessionKey(valueScope, id);
  return {
    ...createOrganizationDocument(valueScope),
    revision,
    pins: [key],
    later: [key],
    completionStates: [
      { sessionKey: key, done: true, revision: 1, executionSequence: 0, markEventId: `mark-${id}` },
    ],
    recentCommandIds: [`mark-${id}`],
  };
}

describe("plugin-owned local file persistence", () => {
  test("a fresh instance restores pins, completion causality, and exact Later order", async () => {
    const directory = await temporaryDirectory();
    const store = createFileStorage({ directory });
    expect(await store.read(scope)).toEqual({ status: "missing" });
    const state = {
      ...document(),
      later: [organizationSessionKey(scope, "third"), organizationSessionKey(scope, "first")],
    };
    expect(await store.compareAndSwap(scope, null, state)).toEqual({
      status: "written",
      acknowledgement: "atomic-replace",
    });
    const restored = await createFileStorage({ directory }).read(scope);
    expect(restored).toEqual({ status: "loaded", value: state });
    expect(await readdir(directory)).toHaveLength(1);
  });

  test("competing instances cannot overwrite a decision based on an obsolete revision", async () => {
    const directory = await temporaryDirectory();
    const first = createFileStorage({ directory });
    const second = createFileStorage({ directory });
    await first.compareAndSwap(scope, null, document());
    const results = await Promise.all([
      first.compareAndSwap(scope, 1, document(2, "left")),
      second.compareAndSwap(scope, 1, document(2, "right")),
    ]);
    expect(results.filter((result) => result.status === "written")).toHaveLength(1);
    const refused = results.find((result) => result.status !== "written");
    expect(
      refused?.status === "conflict" || (refused?.status === "failed" && refused.code === "busy"),
    ).toBe(true);
    const winner = await first.read(scope);
    expect(await second.compareAndSwap(scope, 1, document(2, "obsolete"))).toEqual({
      status: "conflict",
    });
    expect(await first.read(scope)).toEqual(winner);
    expect(await first.compareAndSwap(scope, null, document())).toEqual({ status: "conflict" });
    expect(await readdir(directory)).toHaveLength(1);
  });

  test("distinct server and project identities have separate hashed storage paths", async () => {
    const directory = await temporaryDirectory();
    const store = createFileStorage({ directory });
    const scopes = [
      scope,
      { ...scope, hostId: "other/server" },
      { ...scope, projectId: "other/project" },
    ];
    for (const valueScope of scopes) {
      expect(
        (await store.compareAndSwap(valueScope, null, document(1, "same-session", valueScope)))
          .status,
      ).toBe("written");
    }
    const names = await readdir(directory);
    expect(names).toHaveLength(3);
    expect(names.every((name) => /^organization-[a-f0-9]{64}\.json$/.test(name))).toBe(true);
    for (const valueScope of scopes) {
      expect(await store.read(valueScope)).toEqual({
        status: "loaded",
        value: document(1, "same-session", valueScope),
      });
    }
  });

  test.each([
    ["truncated", '{"version":1,'],
    ["unknown version", JSON.stringify({ ...document(), version: 99 })],
    ["different scope", JSON.stringify(document(1, "first", { ...scope, hostId: "other-server" }))],
    [
      "duplicate identities",
      JSON.stringify({ ...document(), pins: [...document().pins, ...document().pins] }),
    ],
  ])("%s storage is retained verbatim and cannot be overwritten", async (_name, bytes) => {
    const directory = await temporaryDirectory();
    const path = fileStoragePaths(directory, scope).data;
    await writeFile(path, bytes, "utf8");
    const store = createFileStorage({ directory });
    expect((await store.read(scope)).status).toBe("failed");
    expect((await store.compareAndSwap(scope, 1, document(2))).status).toBe("failed");
    expect((await store.compareAndSwap(scope, null, document())).status).toBe("failed");
    expect(await readFile(path, "utf8")).toBe(bytes);
    expect(await readdir(directory)).toHaveLength(1);
  });

  test("an abandoned lock is not stolen, including an empty lock without metadata", async () => {
    const directory = await temporaryDirectory();
    const paths = fileStoragePaths(directory, scope);
    await writeFile(paths.lock, "", "utf8");
    const result = await createFileStorage({ directory }).compareAndSwap(scope, null, document());
    expect(result).toMatchObject({ status: "failed", code: "busy" });
    expect(await readFile(paths.lock, "utf8")).toBe("");
    expect(await readdir(directory)).toEqual([paths.lock.split(/[\\/]/).at(-1)!]);
  });

  test("malformed UTF-8 cannot be normalized into a valid organization document", async () => {
    const directory = await temporaryDirectory();
    const path = fileStoragePaths(directory, scope).data;
    const bytes = Buffer.from(JSON.stringify(document()));
    bytes[bytes.indexOf("mark-first")] = 0xff;
    await writeFile(path, bytes);
    const store = createFileStorage({ directory });
    expect((await store.read(scope)).status).toBe("failed");
    expect((await store.compareAndSwap(scope, 1, document(2))).status).toBe("failed");
    expect(await readFile(path)).toEqual(bytes);
    expect(await readdir(directory)).toHaveLength(1);
  });

  test("a temporary filename collision never deletes a file the writer did not create", async () => {
    const directory = await temporaryDirectory();
    const uuid = "00000000-0000-4000-8000-000000000000";
    const temporaryPath = `${fileStoragePaths(directory, scope).data}.${uuid}.tmp`;
    await writeFile(temporaryPath, "preexisting temporary state", "utf8");
    // Isolate the UUID stub in a child so unrelated crypto users and tests are untouched.
    const source = `
      import { spyOn } from "bun:test";
      import * as crypto from "node:crypto";
      const stub = spyOn(crypto, "randomUUID").mockReturnValue(process.env.SIDEBAR_TEST_UUID);
      try {
        const { createFileStorage } = await import(process.env.SIDEBAR_TEST_STORAGE_MODULE);
        const next = JSON.parse(process.env.SIDEBAR_TEST_DOCUMENT);
        const store = createFileStorage({ directory: process.env.SIDEBAR_TEST_DIRECTORY });
        process.stdout.write(JSON.stringify(await store.compareAndSwap(next.scope, null, next)));
      } finally { stub.mockRestore(); }
    `;
    const child = Bun.spawn({
      cmd: [process.execPath, "--eval", source],
      env: {
        ...process.env,
        SIDEBAR_TEST_STORAGE_MODULE: new URL("../src/storage/file.ts", import.meta.url).href,
        SIDEBAR_TEST_DIRECTORY: directory,
        SIDEBAR_TEST_DOCUMENT: JSON.stringify(document()),
        SIDEBAR_TEST_UUID: uuid,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [output, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(0);
    expect(error).toBe("");
    expect(JSON.parse(output)).toMatchObject({ status: "failed", code: "io-error" });
    expect(await readFile(temporaryPath, "utf8")).toBe("preexisting temporary state");
    expect(await createFileStorage({ directory }).read(scope)).toEqual({ status: "missing" });
    expect(await readdir(directory)).toHaveLength(1);
  });

  test("aborting before replacement preserves the last acknowledged document", async () => {
    const directory = await temporaryDirectory();
    const store = createFileStorage({ directory });
    const original = document();
    await store.compareAndSwap(scope, null, original);
    const controller = new AbortController();
    const options = { signal: controller.signal };
    const pending = store.compareAndSwap(scope, 1, document(2, "cancelled"), options);
    options.signal = new AbortController().signal;
    controller.abort();
    expect(await pending).toMatchObject({ status: "failed", code: "aborted" });
    expect(await store.read(scope)).toEqual({ status: "loaded", value: original });
    expect((await store.read(scope, { signal: controller.signal })).status).toBe("failed");
    expect(await readdir(directory)).toHaveLength(1);
  });

  test("caller mutations after invocation cannot redirect or change a queued replacement", async () => {
    const directory = await temporaryDirectory();
    const callerScope = { ...scope };
    const candidate = {
      ...document(),
      scope: callerScope,
      pins: [...document().pins],
      later: [...document().later],
    };
    const expected = JSON.parse(JSON.stringify(candidate)) as OrganizationDocument;
    const pending = createFileStorage({ directory }).compareAndSwap(callerScope, null, candidate);
    callerScope.hostId = "redirected";
    candidate.pins.length = 0;
    candidate.later.reverse();
    expect((await pending).status).toBe("written");
    expect(await createFileStorage({ directory }).read(scope)).toEqual({
      status: "loaded",
      value: expected,
    });
    expect(await createFileStorage({ directory }).read(callerScope)).toEqual({ status: "missing" });
  });

  test("explicit V0 migration replaces only its observed legacy revision", async () => {
    const directory = await temporaryDirectory();
    const key = organizationSessionKey(scope, "legacy");
    const legacy = {
      version: 0 as const,
      scope,
      revision: 7,
      pins: [key],
      later: [key],
      completed: [key],
    };
    await writeFile(fileStoragePaths(directory, scope).data, JSON.stringify(legacy));
    const store = createFileStorage({ directory });
    expect(await store.read(scope)).toEqual({ status: "loaded", value: legacy });
    const next = { ...migrateOrganizationV0(legacy, scope), revision: 8 };
    expect((await store.compareAndSwap(scope, 7, next)).status).toBe("written");
    expect(await store.compareAndSwap(scope, 7, next)).toEqual({ status: "conflict" });
    const loaded = await store.read(scope);
    expect(loaded).toEqual({ status: "loaded", value: next });
    expect(decodeOrganizationDocument(next, scope).status).toBe("valid");
  });

  test("oversized files and invalid revision changes fail without replacing state", async () => {
    const directory = await temporaryDirectory();
    const store = createFileStorage({ directory, maxBytes: 1_000 });
    expect((await store.compareAndSwap(scope, null, document(2))).status).toBe("failed");
    expect(await store.read(scope)).toEqual({ status: "missing" });
    const path = fileStoragePaths(directory, scope).data;
    await writeFile(path, " ".repeat(1_001));
    expect((await store.read(scope)).status).toBe("failed");
    expect((await store.compareAndSwap(scope, null, document())).status).toBe("failed");
    expect((await readFile(path)).length).toBe(1_001);
    expect(() => createFileStorage({ directory: "relative" })).toThrow();
    expect(() => createFileStorage({ directory, maxBytes: 0 })).toThrow();
  });

  test("separate OS processes serialize writes to the same observed revision", async () => {
    const directory = await temporaryDirectory();
    await createFileStorage({ directory }).compareAndSwap(scope, null, document());
    const storageModule = new URL("../src/storage/file.ts", import.meta.url).href;
    const source = `
      const { createFileStorage } = await import(process.env.SIDEBAR_TEST_STORAGE_MODULE);
      const next = JSON.parse(process.env.SIDEBAR_TEST_DOCUMENT);
      const store = createFileStorage({ directory: process.env.SIDEBAR_TEST_DIRECTORY });
      const result = await store.compareAndSwap(next.scope, 1, next);
      process.stdout.write(JSON.stringify(result));
    `;
    const children = ["left-child", "right-child"].map((id) =>
      Bun.spawn({
        cmd: [process.execPath, "--eval", source],
        env: {
          ...process.env,
          SIDEBAR_TEST_STORAGE_MODULE: storageModule,
          SIDEBAR_TEST_DIRECTORY: directory,
          SIDEBAR_TEST_DOCUMENT: JSON.stringify(document(2, id)),
        },
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const results = await Promise.all(
      children.map(async (child) => {
        const [output, error, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(error).toBe("");
        expect(code).toBe(0);
        return JSON.parse(output) as { status: string; code?: string };
      }),
    );
    expect(results.filter((result) => result.status === "written")).toHaveLength(1);
    const refused = results.find((result) => result.status !== "written");
    expect(
      refused?.status === "conflict" || (refused?.status === "failed" && refused.code === "busy"),
    ).toBe(true);
    const persisted = await createFileStorage({ directory }).read(scope);
    expect(persisted.status).toBe("loaded");
    if (persisted.status === "loaded") {
      const decoded = decodeOrganizationDocument(persisted.value, scope);
      expect(decoded.status).toBe("valid");
      if (decoded.status === "valid") expect(decoded.document.revision).toBe(2);
    }
    expect(await readdir(directory)).toHaveLength(1);
  });
});
