# Architecture

## Status and boundaries

This repository is a project foundation. It does not yet provide an installable, working TUI plugin.
The boundaries below guide implementation; a documented host capability is not evidence that the
sidebar has exercised it successfully.

The product is a session organizer. Pins, the Later list, and completion marks are visual
organization features. Moving a session to Later does not schedule or run it. Marking a session
complete does not stop execution, archive it, generate a report, or perform a repository operation.

## Responsibilities

| Layer               | Owns                                                                                               | Must not own                                                                           |
| ------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Core                | Session organization rules, validated state transitions, selectors, extension contracts            | OpenCode SDK calls, Solid components, filesystem access, timers, environment variables |
| OpenCode adapter    | Translate public host data and events, execute supported host requests, establish session identity | Product-specific execution workflows or assumptions about local repository access      |
| Persistence adapter | Versioned plugin state, storage scope, validation, acknowledgement and concurrency policy          | Reading or rewriting private OpenCode storage files                                    |
| UI                  | Rendering, focus, input, action availability, accessible status presentation                       | Inferring completion from idle status or invoking external workflows implicitly        |
| Optional extensions | Explicit additional actions and reactions to documented events                                     | Changing the meaning of built-in organization actions silently                         |

The core can be tested with ordinary values and fake ports. Host objects are normalized before they
reach it. A second host adapter should reuse those rules without teaching the core about another SDK
or UI framework.

OpenCode V1 is the first planned adapter. OpenCode V2 belongs in this same repository if
implemented, with a separate adapter and its own validation. No V2 scaffolding or compatibility
claim is needed until that work starts.

## Three independent kinds of state

1. **Host activity:** idle, busy, retrying, permissions, and questions, as reported by OpenCode.
   These describe execution and attention requirements.
2. **Organization:** favorite, Later membership, and user-selected completion marks. These describe
   how the user organizes sessions.
3. **Extension activity:** results and progress of an explicitly enabled external workflow. These
   belong to that extension.

A session can be idle without being complete. A completion mark is not proof that an external
workflow succeeded. The UI must preserve these distinctions rather than compressing them into one
overloaded status value.

### Execution correlation

A `session.status` event containing `busy` does not identify a unique execution. Repeated busy
events, reconnects, retries, and parallel activity cannot safely be turned into a new run identifier
by incrementing a local counter.

Any future feature that reacts to a particular execution finishing must establish which host
evidence identifies that execution and its terminal outcome. Message identifiers may be useful
inputs, but their relationship to one user-visible run must be validated against the supported host
version. Until then, correlation is unknown and execution-dependent automation must remain
unavailable. The adapter must not invent certainty from an observed busy-to-idle transition.

## State identity and persistence

Plugin state must be scoped to a stable server identity, project identity, and session identity.
Session identifiers alone are not a sufficient namespace for multiple servers. Plugin keys also need
a package-specific namespace and schema version.

Server identity remains an adapter decision to validate. A temporary local port is not necessarily a
stable server identity; a directory string is not a unique server identity either. Credentials must
not become storage keys. Remote paths must not be canonicalized by probing the client's filesystem.

Use a persistence boundary rather than writing OpenCode's database, native pin files, or other
private state directly. The exact initial persistence backend is not settled by this foundation:

- The V1 public KV store is suitable to investigate for preferences and local organization state. It
  is shared host state, so keys must be namespaced.
- Public session metadata is a possible server-side home for organization marks. If adopted, use a
  plugin-specific metadata key, preserve unrelated metadata, and document visibility across clients.
- Neither option should be treated as a proven durable transaction or cross-instance concurrency
  mechanism without validation.

`api.kv.ready` means startup readiness. It must not be interpreted as a durable acknowledgement for
subsequent writes. A future persistence adapter must state whether a write is merely accepted,
persisted, rejected, or of unknown outcome. Concurrent edits, conflict detection, migrations, and
recovery from invalid data must have an explicit policy before a supported runtime is released.

## Actions and extension events

Built-in organization actions pass through the same state-transition boundary whether initiated by
the UI or an extension. Pure transition results are proposed changes; producing one is not proof of
persistence.

The foundation is not an event dispatcher or a deduplication ledger. Execution sequences reject
replayed starts, and unchanged marks produce no change description. The future coordinator must
deduplicate other input event IDs. An asynchronous explicit mark request must carry the revision it
observed (`expectedRevision`) and its captured execution sequence. A guarded request is also
rejected when its sequence predates newer work, even if the mark revision has not changed. Omitting
the guard is reserved for an immediate action against current state, not a delayed workflow result.

For an event documented as committed, the coordinator must first obtain the required persistence
acknowledgement. If the selected backend cannot provide that guarantee, the event contract must
describe the weaker guarantee honestly. Do not run a side effect on a speculative change and then
label it committed.

Optional observers run independently after the applicable change. An observer failure must not roll
back a successful visual mark or prevent other observers from receiving their event. Extra workflows
that need validation before their own completion should provide an explicit extra action; V1 does
not need general veto hooks for built-in actions.

The extension contract should support stable event identity and origin. Repeating an action that
leaves state unchanged produces no new transition. Hydrating or refreshing existing state must not
replay user actions. Commands issued by an observer retain extension origin, so automatic observers
do not recursively trigger one another by default. Consumers with external effects still require
idempotency; exactly-once delivery is not promised.

Timeouts limit waiting. An abort signal requests cooperative cancellation; it does not guarantee
that arbitrary extension code or an external effect has stopped. This extension boundary is not a
security sandbox.

The OpenCode event API carries host events, not arbitrary sidebar events. Keep the sidebar's
extension contract explicit rather than assuming an undocumented global bus or a shared singleton
across separately bundled packages. The loader and distribution mechanism for extensions remain
future implementation work.

## Local and remote operation

The core and basic UI must not require Git, Python, shell scripts, or direct database access. Host
operations use the supported client API.

Repository information is optional enrichment. A provider may perform read-only, asynchronous Git
queries with bounded execution, caching, and cancellation. It must not block rendering or run one
command per row on every frame. Missing Git, non-repository directories, detached HEAD, and
unavailable directories need ordinary fallback labels.

A host-reported directory may live on a remote server. Local access is unknown until established;
the provider must not assume that an identically named local path refers to that workspace.
Creation, switching, resetting, and deletion of worktrees are outside this read-only enrichment
boundary.

## Runtime dependencies and lifecycle

The future TUI build must use the Solid transform required by OpenTUI while sharing the host's
Solid/OpenTUI runtime. Bundling another reactive runtime can break component ownership and updates.
Pure core entrypoints must not import those UI dependencies.

Activation owns subscriptions, timers, pending reads, and UI state. Disposal must unsubscribe,
cancel cooperative work, and prevent late responses from updating a disposed instance. Reconnection
and refresh must reconcile current host state without pretending that every missed transition was
observed.

## Resource and responsiveness boundaries

Render paths consume normalized state without disk, Git, network, or process operations. Schedule
asynchronous enrichment outside rendering. Updates should invalidate affected sessions; streamed
tokens must not cause full-list refreshes or sorts. Use reliable host events to avoid idle polling
and restrict spinner updates to visible busy rows. Any fallback polling requires documented bounds
and lifecycle cleanup.

Optional metadata loads progressively without delaying navigation. Bound query concurrency, pending
work, and caches; deduplicate directory queries and reject late results after disposal or a newer
request. Persistence contains small organization state rather than copied histories.

Synchronous custom policies must be short and deterministic. Scheduling a listener asynchronously or
timing out its promise does not isolate its CPU work from the host. Integrations remain explicit and
independently disableable; built-in marks, pins, Later actions, and navigation must not launch work
implicitly.

See [performance and transparent behavior](performance.md) for the full requirements and the
controlled stock-OpenCode comparison. These are planned runtime gates, not measured properties of
the current foundation.

## Evidence before release

The first runtime release needs a clean OpenCode installation test, package loading and disposal
checks, persistence/restart and concurrent-instance checks, and focused remote-server behavior
checks. Tests of pure core rules do not prove TUI loading, visual correctness, or end-to-end
compatibility.

Runtime validation also requires predeclared performance budgets, repeatable baseline comparisons,
and lifecycle/resource measurements described in [performance.md](performance.md). Define the
environment and budgets before accepting the adapter; no runtime performance results exist yet.

See [the V1 adapter notes](../src/adapters/opencode-v1/README.md) for the researched host API and
[the UI notes](../src/ui/README.md) for terminal layout constraints.
