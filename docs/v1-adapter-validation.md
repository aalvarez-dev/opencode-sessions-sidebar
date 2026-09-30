# V1 adapter validation

## Delivery status

The headless adapter is implemented against the published OpenCode **1.18.30** public types. It
reads host state and performs native session actions. It is a development library, not a rendered
sidebar, a supported version range, or a stable extension API.

The portable completion/queue core remains separate. This adapter deliberately reports execution
correlation as unavailable: `busy` lacks a run identifier, and the host can create a user message
without starting processing (`noReply`). It never synthesizes core execution-start/finish events.
Automatic completion reopening and report exceptions therefore still need a verified integration.

## Scope and guarantees

Pass an explicit `hostId`, `projectId`, `directory`, and optional `workspaceId` to
`createV1Adapter(host, scope, limits?)`. Keep the original host object so its `client` getter is
read at the start of each operation. Dispose and recreate the adapter when switching scope.

| Capability   | Current behavior                                                                                                                    |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Snapshot     | Subscribes before loading sessions, sparse status, pending permissions, and pending questions.                                      |
| Scope        | One exact directory/workspace; not an aggregation of every worktree or every server.                                                |
| Live updates | Updates affected records and known ancestor summaries; token events do not trigger list reads.                                      |
| Races        | Reconciles buffered live events over snapshots; rejects obsolete results after invalidation/disposal.                               |
| Activity     | Busy, retry, idle, and unknown remain independent from organization marks.                                                          |
| Attention    | Aggregates known descendants. Unloaded sessions or capacity limits produce explicit partial coverage.                               |
| Reconnect    | `server.connected` invalidates and reconciles. The host exposes no public transport-disconnected observable.                        |
| Actions      | Create/rename/delete report confirmed, failed, or unknown outcomes. Open requests navigation; route observation confirms selection. |
| Cleanup      | Cancels pending waits and removes subscriptions/caches on disposal; no idle polling.                                                |

The adapter cannot discover a stable server identity from this TUI API. `hostId` is an explicit
caller-supplied namespace, not a port number or a credential. Persistence and cross-instance
conflict resolution belong to stage 3. Read-model subscriptions are not the proposed versioned
extension event bus and do not promise durable committed events.

Capacity is explicit and configurable: 500 retained sessions, 2,000 pending attention requests,
2,048 recent event IDs, 2,048 events buffered during a snapshot, and a 10-second request timeout by
default. Snapshots issue four concurrent reads; mutations allow one in flight. Timeout means the
outcome of a mutation may be unknown, not that the server rolled it back. A cap or a failed refresh
must not be interpreted as proof that no session needs attention.

The future UI must display partial/unknown coverage, confirm deletes, wire route observation, and
recreate the adapter on scope changes. These responsibilities are not supplied by the headless
library.

## Reproduce the checks

```sh
bun install --frozen-lockfile
bun run check
bun run benchmark:v1
OPENCODE_BIN=/absolute/path/to/opencode bun run smoke:v1
OPENCODE_BIN=/absolute/path/to/opencode bun run smoke:v1 --tui
OPENCODE_BIN=/absolute/path/to/opencode bun run smoke:v1:attention
OPENCODE_BIN=/absolute/path/to/opencode bun run benchmark:v1:runtime
```

The `smoke:v1` command requires an already installed official OpenCode 1.18.30 executable and
rejects another version. It starts a local stock server with temporary configuration/data
directories and an allowlisted environment, creates only synthetic sessions, performs no prompts or
inference, and cleans up its process and temporary files. Test-home, managed-configuration, and XDG
overrides isolate configuration; update checks, model-catalog fetches, and default plugins are
disabled. On macOS the smoke commands reject managed-preference files, which this host version reads
outside those overrides. The harness does not install OpenCode; stock OpenCode may initialize its
own configuration dependencies, so these checks do not claim zero package-registry traffic.

The server test uses a small SDK/SSE bridge for the TUI event/route port. This validates the real
server, official SDK calls, event shapes, and adapter behavior; it does not by itself prove plugin
loading, keyboard handling, TUI route reactivity, rendering, or a shared Solid/OpenTUI runtime.

The optional `--tui` mode uses Bun's POSIX pseudo-terminal to load a temporary ESM probe into the
stock TUI. It exercises the adapter with the real `TuiPluginApi`, including route selection and
disposal, without sending a prompt. It requires Linux or macOS. The probe is not a sidebar, and it
does not establish visual correctness, keyboard navigation, or packaged-plugin compatibility.

`smoke:v1:attention` submits synthetic tool conversations to a deterministic provider fixture bound
to the loopback interface. The official host executes native tools and produces the busy,
permission, and question events; the fixture does not publish host events. This exercises real host
behavior without external model calls, inference, or provider credentials. All configuration,
sessions, and tool work belong to a temporary test environment.

`benchmark:v1:runtime` compares the stock TUI with a common measurement probe against the same setup
with the headless adapter enabled. It requires Linux process counters and a POSIX terminal. The
workload, paired repetitions, limitations, and budgets fixed before measurement are documented in
[performance.md](performance.md). It is an explicit runtime check, separate from cross-platform unit
CI.

## Recorded evidence

Validation environment: Linux x86_64, Bun 1.3.14, official OpenCode/plugin/SDK 1.18.30. All records,
titles, and event workloads are synthetic.

- Stock-server smoke: create, rename, delete, child-session discovery, exact-directory filtering,
  sparse idle status, permission/question list endpoints, identified SSE events, reconnect, and
  disposal passed without inference.
- Transport-owner smoke: killing the server ends its SSE stream; the bridge explicitly calls
  `invalidate()`, producing unknown activity and attention coverage. An offline rename reports an
  unknown outcome and a failed refresh does not certify idle. Restarting the same server reconciles
  retained sessions. This does not establish automatic disconnect detection inside the TUI API.
- Scope smoke: dispose the first adapter and recreate it for another directory while the original
  session still exists. The new adapter excludes the old record, selection, and action targets; old
  event subscriptions are removed. This tests explicit integration ownership, not an undocumented
  native TUI directory-switch operation.
- Live-attention smoke: a synthetic child conversation produces native busy, question, and
  permission events. The adapter reflects child attention in the ancestor summary, preserves it
  across snapshot refreshes, and clears it after replies before returning to idle. The loopback
  fixture receives exactly three provider-protocol requests. This validates the SDK/SSE integration,
  not the future UI's collapsed-group presentation.
- All 69 tests passed (35 core/boundary tests and 34 adapter contract tests), with type checks,
  boundary checks, formatting, and both builds passing. Contract tests cover duplicate busy events,
  event/snapshot races, reply/deletion races, capped lists, descendant summaries, unknown
  scope/attention, action outcomes, and lifecycle cleanup.
- Stock TUI probe: loading the ESM probe, snapshot initialization through the real host object,
  native create/rename/delete, host events initiated outside the adapter, observed session
  navigation, and explicit disposal passed on 1.18.30. Recreating the adapter with the same live
  host object also restores event handling and navigation without retaining old subscriptions.
- The component probe has predeclared budgets in [performance.md](performance.md), including zero
  SDK reads during 10,000 status updates. It prints timing and resource measurements for each run.
  One development run measured 8.01 ms activation and 0.0062 ms event-handler p95, with four initial
  reads, zero event-triggered reads, one changed row per event, and 2,048 retained event IDs. These
  are component measurements from one run, not a stock-TUI baseline or a hardware-independent claim.
- The separate stock-TUI comparison passed the predeclared headless activation, idle RSS/CPU, and
  lifecycle budgets for 25 and 250 sessions. All 12 measurements and the environment are recorded in
  [performance.md](performance.md#recorded-headless-comparison). It does not measure
  rendered-sidebar latency or establish a supported session-count limit.

The headless runtime scenarios now include live attention, transport-owned disconnect/reconnect,
explicit scope replacement, and a controlled startup/idle comparison. The native TUI still exposes
no public transport-disconnected signal or stable server identity; the future integration must
present those limits honestly. A real TUI scope switch and disconnect while attention is pending
remain unverified. Runtime retry and rejected-question scenarios are also not established by these
probes. Before release, validate the packaged sidebar, supported version range, visual/input
behavior under load, persistence, and multi-instance behavior. Passing these headless checks does
not mark the broader runtime and release gates complete.
