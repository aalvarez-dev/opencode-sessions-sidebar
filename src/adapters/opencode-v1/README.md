# OpenCode V1 adapter

## Research baseline, not a supported runtime

OpenCode **1.18.30** is the source-research baseline for this adapter. Its public types and
technical specification contain the capabilities listed below. This does not establish the earliest
compatible version, a supported version range, or a successful runtime test of this repository.

The executable headless adapter is exported from `index.ts`. Its narrow host port is checked against
the published 1.18.30 `TuiPluginApi`, with type-only SDK/plugin imports. It does not register a
sidebar or install a plugin. See
[validation and limitations](../../../docs/v1-adapter-validation.md) before treating source
compatibility as runtime support. The packaged sidebar still requires its own stock-installation
validation before a supported version range is published.

## Implemented boundary

`createV1Adapter(host, scope, limits?)` owns one explicit host/project/directory/workspace scope.
Pass the live host object so its client getter continues to work. Dispose and recreate when changing
scope. Subscribe before `start()`, read immutable session records and descendant summaries, and use
`refresh()` for explicit reconciliation. Incremental status events do not refresh the session list.

The adapter reports unknown/partial coverage, deduplicates a bounded set of event IDs, and fences
old snapshot/action responses after invalidation or disposal. Network waits have a timeout. It does
not poll in the background. Observer notifications are read-model changes, not the future versioned
extension event bus or durable committed organization events.

Session records include the public `Session.agent` name when the host provides it. Missing agent
names remain absent; the adapter does not infer them from titles or private metadata. The UI may
resolve an explicitly configured color through the public `api.state.config.agent` map. There is no
public `api.state.agent` list in the researched TUI contract, and no per-session history reads are
added to fill missing names.

`state().refreshing` is true only while a bounded snapshot read is in progress. Unknown activity
alone does not indicate that a check is running. It becomes false after success, failure,
invalidation, or disposal; there is no checking timer or background polling in the adapter.

`session.error` is observed separately from retry activity. A record exposes `error: true` only when
a non-abort error has been observed and activity is confirmed idle. This matters because the host
also emits errors during recoverable context-overflow handling. A later busy or retry status clears
the observed failure, including a repeated busy status; idle preserves it. An explicit abort clears
pending failure evidence instead of producing a terminal-error indicator. Descendant summaries count
these settled observed errors independently of busy, retry, and attention.

These error observations are connection-local, not a history of task outcomes. Reconnection,
invalidation, or failed reads discard uncertain failure evidence. The list/status snapshot cannot
reconstruct earlier errors after restart, and the adapter does not fetch message histories or infer
a run identifier to invent that information. Events received during a snapshot read are replayed in
order so a newer error/idle pair wins over an older busy snapshot.

`create`, `rename`, and `delete` invoke only native session operations. `open` requests navigation;
`observeRoute()` confirms the host's actual current route. None of these actions sends a prompt. The
future UI must provide delete confirmation and wire route observation through host reactivity.

Scope is intentionally limited to one exact directory/workspace. Repo-wide worktree aggregation,
automatic transport-disconnect detection, stable host identity discovery, persistence, and reliable
execution correlation are not implemented. `busy` and user-message creation never manufacture a core
execution start; completion policies remain separate until stronger evidence is available.

## Public host surfaces

| Surface                                   | Planned use                                                       | Boundary                                                     |
| ----------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------ |
| `@opencode-ai/plugin/tui`                 | Typed TUI entrypoint and host API                                 | Keep these imports out of the pure core                      |
| `api.slots.register`, `sidebar_content`   | Add the session organizer to the sidebar                          | Cooperate with other slot contributions                      |
| `api.route.navigate`                      | Open a selected session                                           | Do not assume navigation changes a process working directory |
| `api.client.session`                      | Read sessions and perform explicitly supported session operations | No private database access                                   |
| `api.client.permission` and question APIs | Reconcile pending attention                                       | Include child sessions where required and verified           |
| `api.event.on`                            | Subscribe to official host events                                 | Not an arbitrary sidebar event emitter                       |
| `api.kv`                                  | Investigate namespaced plugin preferences/state                   | Readiness is not a durable write acknowledgement             |
| `api.keymap`                              | Commands and keyboard interaction                                 | Avoid the deprecated `api.command` surface                   |
| `api.lifecycle`                           | Dispose resources and cooperative work                            | Ignore late results after disposal                           |

The public `Session` type includes directory, project identity, optional workspace and parent
identity, optional agent/model, metadata, and timestamps. The update request supports title,
metadata, permissions, and archive time. A completion mark must not be translated into archive time
unless the user explicitly chose an archive action.

`@opencode-ai/sdk/v2` is the SDK entrypoint used by this V1 host contract. Its `v2` suffix does
**not** establish compatibility with the OpenCode V2 runtime.

## Event translation and reconciliation

Start with the smallest useful host event set:

| Events                                                    | Adapter responsibility                                       |
| --------------------------------------------------------- | ------------------------------------------------------------ |
| `session.created`, `session.updated`, `session.deleted`   | Reconcile session records and organization metadata, if used |
| `session.status`                                          | Update execution activity: idle, busy, or retry              |
| `session.error`                                           | Observe non-abort failures without hiding recovery activity  |
| `permission.asked`, `permission.replied`                  | Track permission attention                                   |
| `question.asked`, `question.replied`, `question.rejected` | Track question attention                                     |
| `vcs.branch.updated`, optionally                          | Invalidate current-workspace branch information              |

Event coverage, project scope, and inactive-session visibility must be tested. Use coalesced
refreshes to reconcile missed events and reconnects. Avoid treating the TUI's currently synchronized
session cache as proof that it contains every session's pending requests.

Normalize host records into core inputs. Preserve unknown or unavailable fields as unknown rather
than guessing. In particular, `busy` is not a run identifier, and `idle` is not evidence that the
user's task was completed.

### Execution frontier contract

The foundation reserves `executionSequence: 0` for the frontier before any confirmed execution.
`execution.started` and `execution.finished` require positive safe integers, beginning at 1; both
reject 0 with a `RangeError`. Explicit mark requests may carry frontier 0 when no execution has been
confirmed. Replayed or older positive sequences are handled by the existing state guards.

This is an input contract, not evidence that the host provides such a sequence. The adapter must
establish reliable ordering and reconcile it across restarts. Do not manufacture it by incrementing
on busy notifications. Unknown activity remains visible as activity without fabricating a start or
finish. Custom policies receive the immutable state from before the incoming activity; the returned
state incorporates accepted execution evidence even when the policy keeps the mark unchanged.

## Persistence and remote identity

Use plugin-namespaced state scoped to server, project, and session. Do not copy host-native pin
files or write SQLite directly. If session metadata is selected for marks, use a plugin-specific key
and preserve metadata owned by others.

The persistence backend, stable server identity, acknowledgement semantics, and multi-instance
conflict policy still require implementation and validation. Do not claim durable committed events
based only on calling `api.kv.set`.

Use the runtime's current client rather than retaining a stale client across a connection change.
Filesystem and Git enrichment must remain optional: a session directory may belong to a remote host.
Local path access is not established by receiving that string.

## Future packaging

The researched V1 format uses a default `{ id, tui }` module, a package `exports["./tui"]`
entrypoint, and explicit configuration in `tui.json` under `plugin`. A package may declare
`engines.opencode`, but that range must follow validation rather than an assumption about all V1
releases.

Publish built artifacts; the documented npm installation path uses `--ignore-scripts`. Retain the
required Solid compilation transform and share the host's Solid/OpenTUI runtime rather than bundling
a second copy.

### Loading and update validation

Keep source modules separate for maintainability. Test the built TUI artifact and its imports in the
actual host before choosing the final distribution shape. The v1.18.30 test suite exercises
directory-to-`index.ts` loading, so a blanket statement that local directories cannot load is not
supported. That test does not exercise this plugin's transitive modules or Solid transform.

The researched `plugin-meta.json` implementation records loading metadata and an update fingerprint;
it is not the entrypoint resolver. Runtime code resolves and imports modules before recording that
metadata. Local fingerprints do not cover the full dependency graph. Test updates rather than
requiring users to delete this host-owned file. Failed dynamic imports may also be cached within a
process, which is a separate loader concern.

Merged configuration deduplicates by npm package name or exact local URL. Distinct entries can still
expose the same plugin ID; the runtime rejects the later registration and reports a duplicate-ID
error. Installation instructions must avoid simultaneous source and packaged registrations.

Required scenarios, still untested here:

- Load the packaged TUI entrypoint on a fresh stock installation, including transitive modules and
  the shared Solid/OpenTUI runtime. Test each documented local and package installation form.
- Upgrade after an entrypoint move, a rebuild, and a transitive-module-only change, with ordinary
  host metadata present. Verify behavior after restart and any claimed reload mechanism.
- Combine global and project registrations, including identical specs and distinct paths with the
  same plugin ID. Confirm one active sidebar and actionable diagnostics for rejected duplicates.
- Recover from a missing dependency or failed import using the documented recovery procedure;
  distinguish process import caching from metadata and avoid destructive cache-cleaning advice.

OpenCode V2 has a different plugin entrypoint and configuration contract. A future V2 adapter should
reuse the core in this repository; these V1 notes do not imply that one bundle can load into both
runtimes.

## Primary references

- [TUI public types, OpenCode v1.18.30](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/plugin/src/tui.ts)
- [SDK data and event types, OpenCode v1.18.30](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/sdk/js/src/v2/gen/types.gen.ts)
- [SDK client methods, OpenCode v1.18.30](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/sdk/js/src/v2/gen/sdk.gen.ts)
- [Session processor error, retry, and recovery ordering, OpenCode v1.18.30](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/session/processor.ts)
- [TUI plugin loading and package specification, OpenCode v1.18.30](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/specs/tui-plugins.md)
- [Directory entrypoint test, OpenCode v1.18.30](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/test/cli/tui/plugin-loader-entrypoint.test.ts)
- [Loader and import failure handling, OpenCode v1.18.30](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/plugin/loader.ts)
- [Plugin metadata, OpenCode v1.18.30](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/plugin/meta.ts)
- [Configuration deduplication, OpenCode v1.18.30](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/config/plugin.ts)
- [TUI activation and duplicate IDs, OpenCode v1.18.30](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/plugin/tui/runtime.ts)
- [OpenCode V2 CLI plugin documentation](https://opencode.ai/v2/docs/build/plugins/cli/)
