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
[V1 adapter validation](v1-adapter-validation.md). Stage 3 now provides plugin-owned local
persistence, explicit schema migration, guarded manual organization commands, and experimental
events; see [storage and events](storage-and-events.md) for evidence and limits. Stage 4 now has an
experimental local TUI entrypoint with sessions, pins, Later, groups, manual marks, context, and
mouse/keyboard actions. The approved Continuista presentation now adds a deduplicated active-first
layout, independent third-line context selectors, live subagent disclosure above context,
independent completion colors, explicit observed error state, and a shared visibility-bound
animation clock. Its stock-host rendering and input evidence, component budget, and remaining
release limits are recorded in [sidebar validation](sidebar-validation.md). The October 4 stability
review adds regression-covered snapshot reconciliation, linear fallback summaries, listener cleanup,
and strict display-option validation, with fresh stock-host smoke receipts in that document. The
October 28 presentation correction removes the active row's redundant ellipsis while keeping its
direct completion action, with stock-host navigation and action checks recorded there. Stages 5–6
are in progress: explicit local extensions and clean package validation are implemented, while the
execution-correlated policy/report gate and final release acceptance remain open. Publishing a
package or release is a separate action after the gates pass.

The [Codespaces lab](codespaces-lab.md) adds reproducible preparation for an isolated
browser-terminal trial with the pinned V1 host, separate scratch profiles, and the existing
stock-host probes. Successful Codespaces provisioning and the manual browser-terminal checklist
remain pending; this preparation does not close remote-host or packaged-release validation gates.
The clean interactive trial also exposed a command-palette visibility defect: sidebar commands now
remain reachable while the host palette is open, with a real Ctrl+P/filter/Enter runtime regression.

The [terminal font setup](terminal-fonts.md) now verifies the centralized icon catalog, including
every animation frame, against a pinned complete family. Explicit current-user font placement
supports Ubuntu/Linux and macOS, with a dry-run default and separate terminal selection. Activation
performs none of those changes. **Check icons** exposes a scrollable visual proof; native client
rendering still needs verification in each declared terminal configuration.

The [extension surface](extensions.md) adds opt-in local-file modules, session menu/palette actions,
guarded organization commands, isolated event listeners, and scope/lifecycle revocation. It remains
experimental. The [execution-correlation audit](execution-correlation.md) documents why automatic
and custom policies cannot yet be connected safely to the pinned host; requested unsupported modes
are rejected explicitly rather than silently running as manual.

[Fresh package validation](release.md) verifies an offline consumer and can repeat the native probes
against the installed artifact. The [rendered resource comparison](sidebar-resource-benchmark.md)
adds predeclared paired CPU/RSS budgets for the complete sidebar. These bounded checks supplement
the existing input, attention, and component tests; they do not establish untested client rendering,
remote disconnect behavior, or a compatibility range.

The [performance requirements](performance.md) apply across these stages: no blocking render-path
I/O, event-driven updates, minimal idle work, bounded resources, and explicit integrations. The
adapter's component and stock-TUI probes have explicitly limited workloads. Their measurements do
not establish the rendered sidebar's responsiveness or the storage layer's performance. The sidebar
has a separate focused smoke; broad release performance and remote-host validation remain pending.

The November 6 hosted campaign exposed excessive offscreen text buffers and confirmed idle activity
during a real native transport cut. The follow-up now mounts row content only near the viewport,
retains complete scroll geometry, and adds a bounded TUI HTTP health monitor with explicit transport
availability at the adapter boundary. Focused stock-host checks verify wide/narrow navigation,
expanded child/context geometry in both balanced and comfortable density, unknown activity during
the cut, automatic recovery and a fresh event after reconnection. A double-cut regression also
covers native recovery between two failed health checks. Full rendered resource budgets are still
evaluated independently; these functional checks do not substitute for their exact receipts.

Hosted macOS validation now separates the ASCII/default-font case from a uniquely named Terminal
profile selecting the pinned font. Both require explicit passing receipts, followed by real pixel
review. The [isolated campaign](isolated-terminal-validation.md) describes provenance and limits;
run-specific results are attached to the validation PR. There is no universal-terminal or Ghostty
acceptance claim, and an SSE-only fault with healthy HTTP remains outside the health fallback.

The November 7 visual alignment work uses the [approved design contract](visual-design.md): an
inline creation header, compact live-subagent trees, default active expansion with explicit user
choices, counted nonempty groups, aligned completion action and a verified clock icon family. A
shared, explicitly synthetic design fixture exercises the unchanged built product inside stock
OpenCode on Linux and macOS. This is presentation evidence only; native execution/attention checks
remain independent. The final `5080241` build passed Ubuntu and macOS pixel review, native
attention/transport checks, container validation and CI. PR #8 was merged into `main` on November 7
as development integration at the owner's explicit request. Its short 250-session CPU comparison
still failed: +1.2050 percentage points against the unchanged +1.0 limit. The delayed comparison
passed at +0.9999 points, with effectively no CPU margin; it does not override the short failure.
Both RSS medians passed in that campaign. The package remains experimental and unpublished, with
resource acceptance and execution correlation still open. See the exact
[campaign record](sidebar-resource-benchmark.md#november-7-development-merge).

The follow-up visual review distinguishes structural agreement from finishing the presentation. More
legible one-cell Material pin/clock/trash glyphs and theme-derived secondary contrast are now
implemented, with font-boundary and dark/light/custom-palette tests. Shared project-context labels
and retry colors are memoized instead of recalculated per row. Native frame acceptance checks now
also inspect the actual secondary-text/control colors and distinct pin/clock states. Candidate
`b4eca46` passed Ubuntu/macOS pixel review, seven shared design checks, native interaction,
attention/transport checks, container validation and CI. Its short 250-session CPU median still
failed at +1.2124 points; delayed RSS/CPU medians passed. This does not establish stable resource
acceptance. The [campaign record](sidebar-resource-benchmark.md#november-7-legibility-follow-up)
retains both results and their exact bundle identity. The prior PR #9 candidate `852b140` passed
functional and graphical checks but failed short 250-session RSS at +84.4258 MiB versus 64 MiB. Its
passing delayed median did not cancel that failure; the diagnostic now distinguishes anonymous,
file-backed and shared RSS using existing process reads.

The subsequent viewport optimization computes compact subtree heights only for expanded roots,
sharing descendants across overlapping open roots. At 250 flat sessions with the active leaf open,
the deterministic child-lookup count falls from 500 to two; fully collapsed rows need none. Existing
promoted-child geometry and deep iterative traversal are preserved. This reduces layout work and
temporary allocations; it is not a demonstrated fix for process-wide idle CPU or RSS. Its native and
resource validation must use its new bundle, not the preceding candidate's receipts.

A further transport cleanup avoids aborting health responses whose JSON body has already been
consumed, while preserving cancellation of pending/rejected requests, timeouts, reconnection and
disposal. A bounded native comparison found a modest, variable CPU reduction; it does not close
resource acceptance. The
[investigation record](sidebar-resource-benchmark.md#fulfilled-health-cleanup-investigation) retains
all three pairs and requires the unchanged original gates on the new candidate. Its first
original-gate validation passed both short comparisons but failed delayed CPU at +1.4001 points
against the unchanged +1.0 limit. The exact bundle passed 222 local tests and eleven native
remote-transport checks; these correctness results do not override the resource failure.

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

## Pending repository workflow decision

Define the branch strategy before enabling repository automation. The candidate is a permissive
`develop` integration branch and a protected `main`, with promotion by pull request and automatic
merge only after the required tests pass. This is a proposal, not an enabled policy.

Decide which checks are required, how feature branches reach `develop`, whether promotion also
requires review, which merge method preserves the desired history, and how hotfixes return to both
branches. Keep the workflow simple for a small project and ensure a newer commit cannot reuse an
older successful check.

Until that decision is made, continue using focused task branches and reviewed PRs to `main` under
the existing contributor instructions. Creating `develop`, changing branch protections, and enabling
automerge are pending maintenance work.

The November 7 graph optimization deduplicates batched ancestor invalidation and shares uncached
subtree summaries. An independent DFS oracle covers flat/deep/wide graphs at 25/250/500 nodes,
structural changes, missing parents, cycles and attention/error facts. Deterministic operation
counts establish improved scaling; these headless regressions do not close the rendered idle-CPU,
prolonged-lifecycle or release acceptance gates.

## V1 integration candidate 1

The frozen product has completed the 20-minute-per-treatment and 50-cycle stability observations.
Two of three original resource campaigns passed; campaign 2 failed, so stable release approval
remains blocked. A separate Linux x64 OpenCode 1.19.3 compatibility trial passed installed-package
sidebar/attention and remote recovery checks. See
[the candidate handoff](v1-integration-candidate.md) for exact identity, all results, isolation,
legacy-sidebar replacement and rollback. Full harness integration remains pending; no server
installation or public package release has been performed.

## Windowed row containers

Top-level groups now mount only nearby row containers, retaining complete scroll geometry through
prefix heights and spacers. The 250-session fixture retains five row containers instead of 250;
native navigation and attention remain available. Original short-window CPU acceptance still fails,
despite a passing delayed window. See [the optimization report](windowed-row-containers.md) and its
machine-readable measurements. No session cap or feature restriction was introduced; stable V1 and
combined-harness integration remain blocked.

A subsequent diagnostic counted all product function entries and compared real/synthetic health
responses within two processes in mirrored order. Only transport-health sites executed during idle;
real requests added +1.4786 and +0.9068 CPU points within their respective processes. See the
[health crossover](health-crossover-diagnostic.md). Changing the five-second interval would change
disconnect detection latency and remains a product decision, not an applied optimization.
