import type { CompletionPolicy } from "../src/core/index";

// Domain examples only: there is no extension loader or OpenCode adapter yet.
export const manual: CompletionPolicy = { mode: "manual" };

// A name is not enough. The adapter must also prove the workflow's relationship
// to the event and exact mark revision that started it.
export const preserveReports: CompletionPolicy = {
  mode: "on-execution",
  preserveFor: ["generate-report"],
};

// An alternative chosen by the user: only their own confirmed new executions
// reopen the session. Activity and attention remain visible for every origin.
export const reopenForUserWork: CompletionPolicy = {
  mode: "custom",
  decide: ({ activity }) =>
    activity.type === "execution.started" && activity.origin.type === "user" ? "clear" : "keep",
};
