import assert from "node:assert/strict";

/** Explicit compatibility trials must not silently replace the original acceptance baseline. */
export const validationHostVersion = process.env.SIDEBAR_TEST_OPENCODE_VERSION ?? "1.18.30";
assert(
  validationHostVersion === "1.18.30" || validationHostVersion === "1.19.3",
  "SIDEBAR_TEST_OPENCODE_VERSION must be 1.18.30 (baseline) or 1.19.3 (integration trial).",
);
