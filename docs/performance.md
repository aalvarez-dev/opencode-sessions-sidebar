# Performance and transparent behavior

These are implementation requirements and planned runtime release gates. Only the pure core has been
built and tested so far. No OpenCode runtime performance has been measured, and this document does
not claim measured overhead, latency targets, or supported session counts.

## Implementation requirements

| Area         | Requirement                                                                                                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Rendering    | Render from normalized state and available metadata without disk, Git, network, or process operations. Schedule asynchronous enrichment outside rendering.                           |
| Updates      | Use event-driven updates scoped to affected sessions. A streamed token must not trigger a full list fetch, rebuild, or sort. Recompute ordering only when an ordering input changes. |
| Idle work    | Prefer reliable host events over polling. Any necessary fallback must document why it exists, its cadence, bounds, and disposal behavior; suspend it when unnecessary.               |
| Animation    | Animate only visible busy rows. Idle, collapsed, and offscreen rows must not keep per-row spinner timers running.                                                                    |
| Metadata     | Show optional repository context progressively. Missing or slow metadata must not delay navigation or basic session actions.                                                         |
| Enrichment   | Bound cache size, entry lifetime, concurrent queries, and pending work. Deduplicate queries per established directory identity, cancel obsolete work, and reject stale results.      |
| Storage      | Persist small plugin-owned annotations, list order, and preferences, not copied session histories. Write meaningful changes rather than animation or token updates.                  |
| Dependencies | Share the host's Solid/OpenTUI runtime; do not bundle another copy into the TUI entrypoint.                                                                                          |
| Lifecycle    | Bound subscriptions, timers, requests, and retained state. Repeated activation, reconnection, and disposal must not accumulate them.                                                 |

Coalesce replaceable metadata or activity updates when appropriate, but preserve actual attention
changes and policy-relevant execution evidence. A resource limit must not silently turn unknown
state into idle or hide a permission request.

Custom completion policies are synchronous and must perform short, deterministic decisions without
I/O or long computations. Document this obligation and make slow-policy diagnostics available.
Asynchronous listeners should yield promptly and use bounded external operations. An async callback
can still block the host before yielding; a timeout limits waiting, not CPU execution. Promises,
timeouts, and cooperative abort signals do not provide CPU isolation or a sandbox.

## Transparent behavior

Marking, pinning, or changing Later membership only changes the corresponding organization state and
emits its documented events. Opening a session only navigates. None of these actions implicitly
starts a prompt, tool, report, repository mutation, or external workflow.

Integrations and automatic reactions are explicitly configured, identifiable by origin, and
disableable. Optional read-only enrichment must have a documented scope and failure behavior. Keep
diagnostics local and bounded; counters do not need session contents, prompts, or retained event
histories. Any future external reporting requires a separately documented opt-in.

## Controlled comparison before release

Before accepting the V1 adapter, define the benchmark environment, workload, and release budgets.
Record the OS, hardware, terminal and dimensions, OpenCode and dependency versions, plugin commit,
configuration, enabled integrations, warm/cold cache conditions, measurement tools, and repetitions.
Choose numerical budgets before evaluating acceptance results; this foundation intentionally does
not invent them.

Compare stock OpenCode with the plugin disabled against the same installation with the plugin
enabled. Keep host data, event workloads, and settings equivalent. Use synthetic sessions and
controlled events to avoid model or network variance being mistaken for plugin cost. Run basic
organization alone first, then optional enrichment and extensions separately. A secondary local
comparison is optional and cannot replace the stock-OpenCode baseline.

| Scenario                    | Measurements and checks                                                                                                                                              |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Idle after startup          | Process CPU, memory, timer/wakeup counts, background reads, and stability over the observation window.                                                               |
| Activation                  | Time to usable navigation, memory growth, initial requests, and metadata queries; compare cold and warm conditions.                                                  |
| Navigation and organization | Input-to-visible-update latency at p50 and p95 for selection, marking, pinning, and Later operations.                                                                |
| Stream and event bursts     | Responsiveness during token streams and mixed session events; full-list refresh/sort counts, per-session updates, pending work, and dropped/coalesced update counts. |
| Growing datasets            | Predeclared small, typical, and stress datasets, with many sessions, directories, children, and attention states; separate total sessions from visible rows.         |
| Repeated lifecycle          | Memory and live subscription, timer, cache-entry, pending-query, and listener counts across activation, reconnect, and disposal cycles.                              |

Use bounded diagnostic counters and snapshots rather than retaining every event. Report absolute
measurements and plugin-versus-baseline differences, with sample counts and test conditions. Do not
hide a regression by changing budgets after measurement; document any proposed budget revision and
its justification before accepting it.

The runtime gate passes only when the recorded budgets and correctness checks both pass. In
particular, maintain attention visibility under load, keep navigation usable while optional metadata
fails or stalls, and prevent disposed or superseded work from changing the UI. Save the reproducible
procedure, measurements, and remaining limitations with release validation. Unit tests and a
successful build alone cannot satisfy this gate.
