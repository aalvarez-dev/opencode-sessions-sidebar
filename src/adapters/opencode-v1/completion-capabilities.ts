/** The verified host capability, separate from the portable core's policy options. */
export const v1CompletionCapabilities = Object.freeze({
  hostVersion: "1.18.30",
  manual: true,
  automatic: false,
  custom: false,
  executionCorrelation: "unavailable",
  reason:
    "OpenCode 1.18.30 does not expose a verified execution identity and start boundary to this adapter.",
} as const);

/** Manual is the only policy currently connected to the V1 host. */
export type V1CompletionPolicy = "manual";

/** Reject unsupported opt-ins; never silently treat a requested automatic policy as manual. */
export function parseV1CompletionPolicy(value: unknown): V1CompletionPolicy {
  if (value === undefined || value === "manual") return "manual";
  if (value === "automatic" || value === "on-execution" || value === "custom") {
    throw new TypeError(
      "completionPolicy is currently limited to manual. " +
        v1CompletionCapabilities.reason +
        ' Use completionPolicy: "manual" or omit it; automatic and custom host policies remain unavailable.',
    );
  }
  throw new TypeError('completionPolicy must be "manual" when supplied.');
}
