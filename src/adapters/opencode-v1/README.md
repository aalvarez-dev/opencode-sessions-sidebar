# OpenCode V1 adapter

## Research baseline, not a supported runtime

OpenCode **1.18.30** is the source-research baseline for this adapter. Its public types and
technical specification contain the capabilities listed below. This does not establish the earliest
compatible version, a supported version range, or a successful runtime test of this repository.

No executable adapter is supplied by these notes. Before release, exercise the packaged plugin
against specific unmodified OpenCode versions and publish only the range that the resulting evidence
supports.

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
| `permission.asked`, `permission.replied`                  | Track permission attention                                   |
| `question.asked`, `question.replied`, `question.rejected` | Track question attention                                     |
| `vcs.branch.updated`, optionally                          | Invalidate current-workspace branch information              |

Event coverage, project scope, and inactive-session visibility must be tested. Use coalesced
refreshes to reconcile missed events and reconnects. Avoid treating the TUI's currently synchronized
session cache as proof that it contains every session's pending requests.

Normalize host records into core inputs. Preserve unknown or unavailable fields as unknown rather
than guessing. In particular, `busy` is not a run identifier, and `idle` is not evidence that the
user's task was completed.

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

OpenCode V2 has a different plugin entrypoint and configuration contract. A future V2 adapter should
reuse the core in this repository; these V1 notes do not imply that one bundle can load into both
runtimes.

## Primary references

- [TUI public types, OpenCode v1.18.30](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/plugin/src/tui.ts)
- [SDK data and event types, OpenCode v1.18.30](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/sdk/js/src/v2/gen/types.gen.ts)
- [SDK client methods, OpenCode v1.18.30](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/sdk/js/src/v2/gen/sdk.gen.ts)
- [TUI plugin loading and package specification, OpenCode v1.18.30](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/specs/tui-plugins.md)
- [OpenCode V2 CLI plugin documentation](https://opencode.ai/v2/docs/build/plugins/cli/)
