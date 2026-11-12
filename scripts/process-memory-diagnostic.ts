/** Diagnostic-only fields from the already-read Linux /proc/<pid>/status text. */
export const processMemoryFields = ["RssAnon", "RssFile", "RssShmem", "VmSwap"] as const;
export type ProcessMemoryField = (typeof processMemoryFields)[number];
export type ProcessMemoryCounter =
  | { status: "available"; kiB: number; miB: number }
  | { status: "unavailable"; reason: "missing" | "invalid" | "duplicate" };
export type ProcessMemoryStatus = Record<ProcessMemoryField, ProcessMemoryCounter>;

/** Kernel `kB` values are KiB. Missing or malformed counters are never zero-filled. */
export function parseProcessMemoryStatus(status: string): ProcessMemoryStatus {
  const lines = status.split("\n");
  const counter = (field: ProcessMemoryField): ProcessMemoryCounter => {
    const candidates = lines.filter((line) => line.startsWith(`${field}:`));
    if (!candidates.length) return { status: "unavailable", reason: "missing" };
    if (candidates.length > 1) return { status: "unavailable", reason: "duplicate" };
    const match = candidates[0]!.slice(field.length + 1).match(/^[ \t]*(\d+)[ \t]+kB[ \t]*$/);
    const kiB = match ? Number(match[1]) : NaN;
    if (!Number.isSafeInteger(kiB) || kiB < 0) return { status: "unavailable", reason: "invalid" };
    return { status: "available", kiB, miB: kiB / 1024 };
  };
  return {
    RssAnon: counter("RssAnon"),
    RssFile: counter("RssFile"),
    RssShmem: counter("RssShmem"),
    VmSwap: counter("VmSwap"),
  };
}
