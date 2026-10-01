# Performance and transparent behavior

These are implementation requirements and runtime release gates. The V1 adapter has component
measurements and a limited stock-TUI comparison recorded below. These headless workloads do not
establish rendered-sidebar latency, general process overhead, or a supported session count.

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
Choose numerical budgets for each defined workload before evaluating acceptance results. The
headless budgets below cover only their stated scope.

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

## V1 component probe (predeclared budgets)

`bun run benchmark:v1` uses Bun 1.3.14, 1,000 synthetic same-directory sessions, an in-memory SDK
transport, and 10,000 alternating busy/idle events for one session. It has no network or model
calls. The first measurement environment is Linux x86_64. The following budgets are fixed before
running the probe; its result must not be described as stock-TUI performance:

- Snapshot activation: at most 250 ms, excluding a real host's network and disk latency.
- Event handler p95: at most 2 ms on this component workload.
- No additional SDK requests during the event burst.
- Each status change invalidates only the affected session in this flat workload.
- Event deduplication remains bounded and disposal removes every event subscription.

The command prints its environment and measurements. It is an explicit development check rather than
a timing assertion in cross-platform unit CI. These component budgets do not replace the controlled
baseline comparison above; terminal rendering, input latency, idle process CPU/memory, and slow
real-host behavior still require their own recorded runtime results.

## Headless stock-TUI comparison (predeclared budgets)

The next comparison targets the adapter inside official OpenCode 1.18.30 on Linux, not the future
rendered sidebar. Use a 140-by-40 `xterm-256color` pseudo-terminal, synthetic datasets of 25 and 250
sessions, and three paired repetitions per dataset. Alternate baseline/enabled order. Both use the
same minimal measurement probe and equivalent temporary data/configuration; only the enabled run
loads the adapter. Use fresh processes with warm operating-system caches, without prompts, model
inference, optional integrations, or user configuration.

After two seconds of stabilization, observe five seconds of idle. Record the TUI process's RSS and
CPU time through Linux `/proc`, hardware/kernel, Bun and OpenCode versions, source revision, each
pair, and request/subscription counts. These budgets are fixed before the first measurement:

| Measurement                      | Budget per dataset                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| Headless activation p95          | At most 500 ms                                                                     |
| Median paired RSS increase       | At most 32 MiB                                                                     |
| Median paired CPU increase       | At most 1.0 percentage point of one CPU core                                       |
| Snapshot reads                   | Exactly four per activation                                                        |
| Additional SDK reads during idle | Zero                                                                               |
| Three activate/dispose cycles    | Zero retained subscriptions, cleanup callbacks, or pending requests after disposal |

Report process-start-to-ready time as context without an acceptance threshold. It is not
input-to-paint latency. With three repetitions, p95 is effectively the largest observed activation;
the sample does not establish a statistical latency bound. A shared measurement probe adds its own
overhead, and process RSS/CPU do not measure the whole machine or unobserved child processes.
Rendering, keyboard responsiveness, long idle periods, event-burst process overhead, and packaged
sidebar behavior still require separate validation. A failed budget must be reported, not widened
after observing the result.

### Recorded headless comparison

The complete run passed the original budgets. The
[raw measurements](validation/v1-runtime-baseline.json) contain all 12 treatments, paired deltas,
resource counters, and environment metadata. Environment: Linux x86_64, kernel 6.18.44, AMD EPYC
9V74 with nine visible logical CPUs and 9.73 GiB visible memory, Bun 1.3.14, and OpenCode/plugin/SDK
1.18.30. This is a shared development environment, not dedicated benchmark hardware.

The tested tree was based on `a739983e133aeb396ad59f3d8d3cd435a8b73963`, with the new harness files
uncommitted. To identify the measured content, the command also records a SHA-256 over the harness,
probe, adapter, and type files: `a638e8fafbd3bdd9737cde644dcfb692215a7017aa68e0f80df8c1afd8bfc72e`.

| Measurement                                             | 25 sessions              | 250 sessions             | Predeclared budget        |
| ------------------------------------------------------- | ------------------------ | ------------------------ | ------------------------- |
| Initial activation p95 (maximum of three)               | 203.36 ms                | 185.93 ms                | ≤500 ms                   |
| Median RSS, baseline / enabled                          | 715.43 / 723.53 MiB      | 715.43 / 716.73 MiB      | Descriptive               |
| Median paired RSS increase                              | +10.23 MiB               | +0.26 MiB                | ≤32 MiB                   |
| Median CPU, baseline / enabled                          | 2.199% / 2.599%          | 2.398% / 2.199%          | Descriptive; one CPU core |
| Median paired CPU increase                              | +0.400 percentage points | −0.199 percentage points | ≤1.0 percentage point     |
| Median process-start-to-probe-ready, baseline / enabled | 3653.81 / 3678.53 ms     | 3598.73 / 3671.25 ms     | Descriptive               |

Paired deltas are calculated before taking the median; they need not equal the difference between
the two descriptive medians. Negative deltas reflect variation, not a demonstrated improvement.
Every enabled treatment made four initial SDK reads and zero additional reads during idle. All three
activate/dispose cycles per enabled treatment ended with zero instrumented event subscriptions,
cleanup callbacks, and pending requests. These counters do not prove the absence of every timer or
heap allocation retained by the host.

## Experimental rendered sidebar

Stage 4 adds a focused stock-TUI input/render smoke and a separate reactive-controller workload.
Their predeclared budgets, exact measured results, source digests, and limitations are recorded in
[sidebar validation](sidebar-validation.md). The native input sample uses real PTY mouse/keyboard
and public rendered frames; the controller sample uses synthetic host ports and no terminal. Neither
extends the headless CPU/RSS comparison to the rendered plugin. Full packaged-release performance,
larger rendered datasets, long idle observation, and remote-host behavior remain gates.
