# Roadmap

The repository starts with a small, testable foundation. Each stage must leave the documented
feature status accurate; a build alone does not establish that the plugin works in OpenCode.

| Stage                 | Deliverable                                                                                                        | Exit gate                                                                                                                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Foundation         | Pure completion policies and manual Later-list behavior; typed domain boundaries; reproducible development checks. | Type checks, meaningful domain tests, boundary checks, and build pass. No OpenCode or UI dependencies in the core.                                                                                                                                 |
| 2. V1 adapter         | Public-API capability mapping, initial snapshots, event translation, action outcomes, and reconnect behavior.      | Runtime validation on stock OpenCode; duplicate busy events, uncertain correlation, disconnected status, and child-session attention handled explicitly. Define the performance environment and budgets before acceptance; record tested versions. |
| 3. Storage and events | Plugin-owned persistence with schema migration; versioned events; subscriber lifecycle and failure isolation.      | Restart restores pins, marks, and Later order without firing old actions; stale events and operations cannot overwrite newer decisions.                                                                                                            |
| 4. Sidebar            | Sessions, pins, groups, context, Later controls, mark action, and independent activity/attention indicators.       | Mouse and keyboard smoke tests, narrow and wide layouts, theme and icon fallback checks; no attention hidden by completion or collapse. Validate responsive navigation during event bursts and slow optional metadata.                             |
| 5. Extension surface  | Completion-policy configuration, explicit mutation APIs, optional custom menu/palette actions, and examples.       | A report example preserves its own mark exception while a concurrent user task still reopens the session; listener errors and cleanup tested.                                                                                                      |
| 6. Public release     | Installation instructions, compatibility table, package contents, changelog, and release process.                  | Fresh stock-OpenCode installation works from the packaged artifact; runtime scenarios and predeclared performance budgets pass against a controlled baseline, and known limits are documented.                                                     |

The foundation is implemented. Stage 2 has a headless adapter and contract tests; its exact runtime
evidence and remaining acceptance gates are recorded in
[V1 adapter validation](v1-adapter-validation.md). Stages 3–6 remain planned. Publishing a package
or release is a separate action after the gates pass.

The [performance requirements](performance.md) apply across these stages: no blocking render-path
I/O, event-driven updates, minimal idle work, bounded resources, and explicit integrations. The
adapter's component probe does not establish stock-OpenCode process overhead or TUI responsiveness.

## Required runtime scenarios

- Mark/unmark an idle session; restart and recover the correct state.
- Mark a busy session; repeated events from the current execution preserve the mark.
- Start new work in a marked session; apply the configured policy and keep activity visible.
- Show permission requests, questions, retry, and descendant attention even when the session is
  marked or its group is collapsed.
- Run a correlated report extension while a separate user task starts; do not let the report's
  exception or late result override that task.
- Add, open, reorder, and remove Later entries without starting work or changing completion/pins
  implicitly.
- Reconnect to a host, including a remote host or missing repository context, without inventing
  execution or local Git information.
- Disable or fail an extension without blocking normal navigation or corrupting plugin state.
- Compare stock OpenCode with and without the plugin using synthetic workloads and recorded
  versions/settings. Measure idle CPU, memory, activation, navigation p50/p95, event bursts, many
  sessions, and repeated lifecycle cycles under budgets defined before adapter acceptance.
- Verify bounded caches, queries, timers, subscriptions, and diagnostic counters; ensure optional
  metadata and late responses cannot stall navigation or update a disposed instance.

## Future OpenCode V2

Keep a V2 adapter in this repository if practical. Reuse the domain model, test the actual V2 APIs
independently, and share UI components only where compatible. Choose one package with separate entry
points or multiple packages after verifying host loading and dependency constraints. Do not maintain
permanent product branches merely to distinguish host versions.

Plugin release numbers and supported OpenCode versions are separate. V1 integration is the current
target; V2 support has no release commitment yet.
