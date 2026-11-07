/** Separate forensic run; host snapshots may collect garbage and inflate RSS. */
process.env.SIDEBAR_MEMORY_HEAPS = "true";
await import("./diagnose-memory-phases");
export {};
