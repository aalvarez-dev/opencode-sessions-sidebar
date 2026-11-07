/** Approved-design visual inputs, shared by Linux and macOS. Never a native execution fixture. */
export const designSessions = [
  { key: "release", title: "Preparar la próxima versión", agent: "architect", minutes: 2 },
  { key: "branches", title: "Definir estrategia de ramas", agent: "architect", minutes: 60 },
  { key: "review", title: "Revisar los cambios", agent: "reviewer", minutes: 5 },
  { key: "docs", title: "Actualizar documentación", agent: "build", minutes: 12 },
  {
    key: "security",
    title: "Synthetic security child",
    agent: "security.reviewer",
    minutes: 1,
    parent: "release",
  },
  {
    key: "backend",
    title: "Synthetic backend child",
    agent: "backend",
    minutes: 1,
    parent: "release",
  },
  {
    key: "review-child",
    title: "Synthetic review child",
    agent: "reviewer",
    minutes: 1,
    parent: "review",
  },
] as const;

export const designAgentConfig = {
  architect: { color: "#91bddd", mode: "primary" },
  reviewer: { color: "#91bddd", mode: "all" },
  build: { color: "#91bddd" },
  "security.reviewer": { color: "#c3a0dd", mode: "subagent" },
  backend: { color: "#91bddd", mode: "subagent" },
} as const;

export const designLimitations = [
  "Visual fixture only: public-read inputs for activity, attention and ages are synthetic; nativeExecutionValidated is false.",
  "Sessions and selected route are real host records; organization is prepared through the plugin-owned service before activation.",
  "The unchanged built product renders in stock OpenCode. PNGs must come from the real terminal window, not reconstructed buffers.",
  "Repository/branch/worktree come from the public current-directory context. Distinct per-session worktrees in the HTML are illustrative, not supported by this adapter.",
  "The host owns terminal cell geometry, native Context/LSP/onboarding panels, theme and client font selection.",
] as const;

if (import.meta.main)
  console.log(JSON.stringify({ agent: designAgentConfig, limitations: designLimitations }));
