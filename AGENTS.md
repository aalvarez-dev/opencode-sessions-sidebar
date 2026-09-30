# Contributor and agent instructions

Read `docs/specification.md`, `docs/architecture.md`, and `docs/roadmap.md` before changing product
behavior. This repository is currently a foundation, not an installable OpenCode plugin. Keep that
distinction explicit in documentation.

## Architecture

- Keep `src/core` portable and deterministic. It must not depend on OpenCode, OpenTUI, Solid, Bun,
  Node, filesystem, network, wall-clock time, or a terminal.
- Connect host capabilities through version-specific adapters. OpenCode V1 is the first target; V2
  support must be verified independently in the same repo.
- Use documented/public host APIs. Store plugin-owned annotations separately from native session
  files. Preserve host-owned execution and attention state.
- Never bundle a second Solid/OpenTUI runtime into the eventual TUI entrypoint.

## Product invariants

- Completion is a visual annotation. It never hides activity or attention, archives a session,
  changes selection, or changes pins/queue membership.
- A user may mark a busy session. A repeated busy update is not proof of a new execution. Do not
  infer causal relationships from timing.
- Completion policy decisions and asynchronous integration side effects are separate. No-op changes
  do not produce change events.
- “Later” is an ordered list of sessions, not a runner. No Run all action.
- Extension failures must not undo committed user actions or block the UI.

## Workflow

- Work in a task branch and open a focused PR to `main`.
- Keep code and public documentation in English.
- Use Bun 1.3.14 and commit `bun.lock`. Run `bun run check` before proposing a PR.
- Test behavior and relevant races. Keep foundation tests distinct from actual OpenCode runtime
  compatibility tests; do not claim the latter from the former.
- Update the roadmap when a capability becomes implemented and verified.
- Preserve license notices for any reused code. Do not copy personal settings, credentials, local
  paths, or unrelated repository history into this project.
- Keep documentation self-contained and examples synthetic. Do not describe nonpublic project
  provenance or include real repository/service identifiers or session contents in public changes.
- Verify author and committer metadata before publishing commits. Use the account's GitHub `noreply`
  address when a personal email address has not been explicitly approved for publication.
- Keep the package private until a usable TUI entrypoint and release validation exist. Publishing
  packages and changing host/repository settings are separate release or maintenance actions, not
  side effects of builds or tests.
