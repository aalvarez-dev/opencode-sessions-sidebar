import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  decodeOrganizationDocument,
  ORGANIZATION_LIMITS,
  validateOrganizationScope,
} from "../organization/schema";
import type {
  OrganizationDocument,
  OrganizationScope,
  StorageOptions,
  StoragePort,
  StorageReadResult,
  StorageWriteResult,
} from "../organization/types";

export interface FileStorageOptions {
  /** Explicit local, private directory. Host-reported remote paths are not suitable. */
  readonly directory: string;
  /** A lower storage bound may be used; the schema's hard byte limit still applies. */
  readonly maxBytes?: number;
}

export interface FileStoragePaths {
  readonly data: string;
  readonly lock: string;
}

/** Paths are diagnostic information, not an API for deleting a live writer's lock. */
export function fileStoragePaths(directory: string, scope: OrganizationScope): FileStoragePaths {
  requireDirectory(directory);
  const stableScope = validateOrganizationScope(scope);
  const digest = createHash("sha256")
    .update(JSON.stringify([stableScope.hostId, stableScope.projectId]))
    .digest("hex");
  const data = join(directory, `organization-${digest}.json`);
  return Object.freeze({ data, lock: `${data}.lock` });
}

function requireDirectory(directory: string): void {
  if (typeof directory !== "string" || !isAbsolute(directory) || directory.includes("\0")) {
    throw new RangeError("Storage requires an absolute local directory.");
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function ioMessage(action: string, error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? ` (${error.code})`
      : "";
  return `${action}${code}.`;
}

const cancelled = (): StorageWriteResult => ({
  status: "failed",
  code: "aborted",
  message: "Storage operation was cancelled before replacement.",
});

/**
 * Small local-file backend for cooperating instances, with fail-closed lock recovery.
 *
 * The receipt means the temporary file was synced and rename completed. It is not a
 * promise of power-loss durability, support for network/sync filesystems, or protection
 * against another application directly editing these files. No orphan lock is stolen.
 */
export function createFileStorage(options: FileStorageOptions): StoragePort {
  requireDirectory(options.directory);
  const directory = options.directory;
  const maxBytes = options.maxBytes ?? ORGANIZATION_LIMITS.maxDocumentBytes;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > ORGANIZATION_LIMITS.maxDocumentBytes
  ) {
    throw new RangeError("Storage byte limit must be within the schema's supported bound.");
  }

  async function readPath(
    path: string,
    scope: OrganizationScope,
    signal?: AbortSignal,
  ): Promise<StorageReadResult> {
    if (signal?.aborted) return { status: "failed", message: "Storage read was cancelled." };
    let handle: FileHandle | undefined;
    try {
      // This backend is for a caller-owned directory, not hostile shared storage. The
      // check rejects accidental symlinks and special files rather than following them.
      const entry = await lstat(path);
      if (!entry.isFile()) {
        return { status: "failed", message: "Organization state must be a regular file." };
      }
      if (entry.size > maxBytes) {
        return { status: "failed", message: "Organization state exceeds the storage byte limit." };
      }
      handle = await open(path, "r");
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > maxBytes) {
        return { status: "failed", message: "Organization state is not a bounded regular file." };
      }
      // Read at most maxBytes + 1 even if an unsupported external writer grows the file.
      const bytes = Buffer.alloc(maxBytes + 1);
      let count = 0;
      while (count < bytes.length) {
        if (signal?.aborted) return { status: "failed", message: "Storage read was cancelled." };
        const result = await handle.read(bytes, count, bytes.length - count, count);
        if (result.bytesRead === 0) break;
        count += result.bytesRead;
      }
      if (count > maxBytes) {
        return { status: "failed", message: "Organization state exceeds the storage byte limit." };
      }
      let value: unknown;
      try {
        const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count));
        value = JSON.parse(json);
      } catch {
        return { status: "failed", message: "Organization state is not valid JSON." };
      }
      const decoded = decodeOrganizationDocument(value, scope);
      if (decoded.status === "invalid") return { status: "failed", message: decoded.message };
      return { status: "loaded", value };
    } catch (error) {
      if (hasCode(error, "ENOENT")) return { status: "missing" };
      return { status: "failed", message: ioMessage("Could not read organization state", error) };
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async function read(
    scope: OrganizationScope,
    options: StorageOptions = {},
  ): Promise<StorageReadResult> {
    try {
      const stableScope = validateOrganizationScope(scope);
      return await readPath(
        fileStoragePaths(directory, stableScope).data,
        stableScope,
        options.signal,
      );
    } catch {
      return { status: "failed", message: "Invalid organization storage scope." };
    }
  }

  async function compareAndSwap(
    scope: OrganizationScope,
    expectedRevision: number | null,
    next: OrganizationDocument,
    options: StorageOptions = {},
  ): Promise<StorageWriteResult> {
    const signal = options.signal;
    if (signal?.aborted) return cancelled();
    let stableScope: OrganizationScope;
    let paths: FileStoragePaths;
    let serialized: string;
    try {
      stableScope = validateOrganizationScope(scope);
      paths = fileStoragePaths(directory, stableScope);
      if (
        expectedRevision !== null &&
        (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
      ) {
        throw new RangeError("Invalid expected revision.");
      }
      const decoded = decodeOrganizationDocument(next, stableScope);
      if (decoded.status !== "valid" || decoded.document.revision !== (expectedRevision ?? 0) + 1) {
        throw new RangeError("Invalid replacement document or revision.");
      }
      // Capture caller-owned values before the first await, including all nested arrays.
      serialized = `${JSON.stringify(decoded.document)}\n`;
      if (Buffer.byteLength(serialized) > maxBytes) throw new RangeError("Document too large.");
    } catch {
      return {
        status: "failed",
        code: "invalid-data",
        message: "Invalid replacement document, scope, revision, or storage byte size.",
      };
    }

    let lock: FileHandle | undefined;
    let lockIdentity: { readonly dev: number; readonly ino: number } | undefined;
    let temporary: FileHandle | undefined;
    let temporaryPath: string | undefined;
    let temporaryCreated = false;
    let renameAttempted = false;
    let replaced = false;
    let result: StorageWriteResult;
    const warnings: string[] = [];
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (signal?.aborted) return cancelled();
      try {
        lock = await open(paths.lock, "wx", 0o600);
        lockIdentity = await lock.stat();
      } catch (error) {
        if (hasCode(error, "EEXIST")) {
          return {
            status: "failed",
            code: "busy",
            message: "Organization storage is locked. No automatic lock recovery was attempted.",
          };
        }
        throw error;
      }
      const current = await readPath(paths.data, stableScope, signal);
      if (signal?.aborted) {
        result = cancelled();
      } else if (current.status === "failed") {
        result = { status: "failed", code: "invalid-data", message: current.message };
      } else {
        let currentRevision: number | null = null;
        if (current.status === "loaded") {
          const decoded = decodeOrganizationDocument(current.value, stableScope);
          // readPath already validates this owned snapshot. Retain the explicit check
          // here so future decoder changes cannot turn corrupt data into a missing file.
          if (decoded.status === "invalid") throw new Error("Invalid stored document.");
          currentRevision =
            decoded.status === "valid" ? decoded.document.revision : decoded.legacy.revision;
        }
        if (currentRevision !== expectedRevision) {
          result = { status: "conflict" };
        } else if (signal?.aborted) {
          result = cancelled();
        } else {
          temporaryPath = `${paths.data}.${randomUUID()}.tmp`;
          temporary = await open(temporaryPath, "wx", 0o600);
          temporaryCreated = true;
          await temporary.writeFile(serialized, "utf8");
          await temporary.sync();
          await temporary.close();
          temporary = undefined;
          if (signal?.aborted) {
            result = cancelled();
          } else {
            // From this point cancellation cannot truthfully promise no replacement.
            // Keep the lock until rename settles; never race it against a timeout.
            renameAttempted = true;
            await rename(temporaryPath, paths.data);
            replaced = true;
            temporaryPath = undefined;
            result = { status: "written", acknowledgement: "atomic-replace" };
          }
        }
      }
    } catch (error) {
      result = renameAttempted
        ? {
            status: "unknown",
            message: ioMessage(
              "Organization replacement outcome is unknown; reload before retrying",
              error,
            ),
          }
        : {
            status: "failed",
            code: "io-error",
            message: ioMessage("Organization write failed", error),
          };
    } finally {
      // Await outstanding I/O and close before removing our exclusive lock. A crashed
      // process can leave the lock behind; another instance deliberately fails closed.
      await temporary?.close().catch((error: unknown) => {
        warnings.push(ioMessage("Could not close temporary organization state", error));
      });
      if (temporaryCreated && temporaryPath) {
        await unlink(temporaryPath).catch((error: unknown) => {
          if (!hasCode(error, "ENOENT")) {
            warnings.push(ioMessage("Could not remove temporary organization state", error));
          }
        });
      }
      if (lock) {
        await lock.close().catch((error: unknown) => {
          warnings.push(ioMessage("Could not close organization lock", error));
        });
        try {
          const currentLock = await lstat(paths.lock);
          if (
            !lockIdentity ||
            !currentLock.isFile() ||
            currentLock.dev !== lockIdentity.dev ||
            currentLock.ino !== lockIdentity.ino
          ) {
            warnings.push(
              "Organization lock identity changed; its replacement was left untouched.",
            );
          } else {
            await unlink(paths.lock);
          }
        } catch (error) {
          warnings.push(
            ioMessage("Could not remove organization lock; offline recovery may be needed", error),
          );
        }
      }
    }
    if (replaced) {
      return warnings.length
        ? { status: "written", acknowledgement: "atomic-replace", diagnostic: warnings.join(" ") }
        : { status: "written", acknowledgement: "atomic-replace" };
    }
    if (warnings.length && result.status === "failed") {
      return { ...result, message: `${result.message} ${warnings.join(" ")}` };
    }
    return result;
  }

  return Object.freeze({ read, compareAndSwap });
}
