# Organization storage and events

This development layer stores plugin-owned pins, completion marks, and the ordered Later list. It
does not store native session histories, activity, attention, or credentials. Its event contract is
experimental, and it does not install or render the sidebar.

## Scope and storage choice

The caller supplies a stable `hostId` and `projectId`. Session keys are the canonical JSON tuple
`[hostId, projectId, sessionId]`, matching the V1 adapter. Credentials, temporary server ports, and
assumed local paths are not server identities. The caller must also supply an explicit local
directory reserved for the plugin's files. Do not derive it from a remote host's reported path.

The first backend uses asynchronous filesystem operations and one document per scope. It does not
edit OpenCode's database, session files, or native preferences. The public V1 KV API has a void
`set()` and startup `ready` flag, but no compare-and-swap or write receipt; those operations cannot
provide this coordinator's acknowledgement and concurrency contract.

Storage filenames derive from a hash of the scope. All cooperating writers use an exclusive lock,
read and validate the current revision inside that lock, and replace the document only when it
matches the expected revision. The backend writes a temporary file in the same directory, flushes
and closes it, and atomically renames it over the target. It never deletes the old document first.

The `atomic-replace` receipt means that replacement completed and can be read after an ordinary
process restart. It is not a promise of survival through operating-system crashes or power loss: the
backend does not claim universal directory-flush or storage-device guarantees. Use a local
filesystem; network and synchronization-folder semantics are outside this backend's contract.

Lock contention fails promptly. There is no idle polling or automatic retry/rebase. An interrupted
filesystem operation retains its lock until that operation settles. An outcome that may have
replaced the document is reported as unknown, not as a guaranteed rollback. Reload before deciding
what to do next.

An orphan lock after a process crash is not stolen based on age or PID. For recovery, stop all
writers, preserve the data and lock files, inspect the validated document, and only then remove the
orphan lock identified by `fileStoragePaths()`. Invalid, truncated, foreign-scope, or newer-version
documents are never silently reset or overwritten. Recovery of those files is an explicit
maintenance decision.

## Schema and migration

Version 1 contains the scope, document revision, pins, Later order, completion states, imported-mark
markers, and a bounded recent-command ledger. It retains at most 5,000 distinct session identities,
256 recent changed-command IDs, and 1 MiB of encoded JSON. Validation returns detached immutable
values, rejects duplicate identities and unsafe revisions, and preserves the distinction between
document revisions, visual-mark revisions, and confirmed execution sequences.

Version 0 exists only as an unpublished migration fixture. It contains pins, Later order, and bare
completion booleans. Loading it requests migration rather than writing automatically. Explicit
migration uses compare-and-swap, advances the document revision, and emits no action events.
Imported marks remain flagged as unreconciled: their missing causal history is not reconstructed
from timestamps, busy events, or synthetic run IDs. Unknown schema versions remain untouched.

## Commands and events

Every mutation supplies a unique command ID, origin, and the document revision it observed. A
successful change advances the revision; a stale revision is refused instead of being applied to a
newer decision. The bounded persisted ledger deduplicates recently changed commands, while the
required revision guard prevents older replays from overwriting newer state after ledger eviction.
No-op operations do not write or emit change events.

A confirmed execution frontier can advance without changing the visual mark; that metadata is
persisted without emitting a completion-change event. Callers must supply actual confirmed evidence,
not a counter derived from busy events. This API cannot reconcile an imported mark's missing causal
history: a same-value request with a higher frontier is refused until explicit clear/re-mark.

The coordinator applies manual pin, completion, and Later operations. Completion, pins, and Later
membership stay independent. These commands do not navigate, start execution, clear attention,
archive sessions, or invoke a provider. Automatic completion policies still need verified execution
correlation and are not wired to the V1 host by this layer.

Only an acknowledged replacement can update the committed snapshot and produce a change event.
Failed, conflicting, uncertain, and disposed operations do not emit speculative events. Loading,
refreshing, and migrating state never replay old user actions. Another instance's writes become
visible through explicit refresh or a detected conflict; this backend does not watch files or
broadcast between processes.

Version 1 envelopes carry a distinct output event ID, scope, acknowledged document revision, origin,
and the initiating command as `causationId`. Optional correlation and diagnostic time do not
establish ordering. Completion events also carry the visual-mark revision. The implemented families
are `session.pin.changed`, `session.completion.changed`, `queue.added`, `queue.removed`, and
`queue.reordered`; proposed host/action/presentation events remain separate future work. The core's
`markEventId` remains the initiating command ID, available as `causationId`; it is not the output
envelope ID. Future workflow helpers must preserve that distinction.

Reaction listeners receive immutable events and commands bound to their extension identity and
captured revision. Extension-origin changes do not trigger further automatic reactions, preventing
ordinary observer loops. Listeners run after the storage acknowledgement and are isolated from the
mutation result; their failures do not roll back a successful change. Delivery is bounded and best
effort, with no durable outbox or replay guarantee. External effects still require their own
idempotency.

Defaults bound the service to 64 pending commands, 64 subscribers, 256 pending deliveries, and one
actual storage operation. Listener waiting times out after one second; storage waiting after ten
seconds. Timed-out work retains its resource reservation until it actually settles, so repeated
calls cannot accumulate unbounded orphan promises. A timed-out listener is disabled and its bound
commands revoked. The snapshot exposes pending counts, listener failures/timeouts, and dropped
deliveries for local diagnostics.

An asynchronous listener must `await context.dispatch(...)` before returning. Its bound command
context is revoked when the callback completes, throws, times out, unsubscribes, or is disposed;
fire-and-forget work cannot retain authority to overwrite later decisions.

Disposal removes subscriptions and rejects obsolete work. Timeouts limit waiting, not arbitrary
JavaScript CPU work or the lifetime of noncooperating external effects. This API is not a sandbox.

## Validation

```sh
bun run check
OPENCODE_BIN=/absolute/path/to/opencode bun run smoke:organization
```

The runtime probe uses official OpenCode 1.18.30 and two isolated TUI processes to exercise writing
and restoration through the real host. It creates only synthetic sessions and a temporary,
explicitly local storage directory. It does not send prompts or use model inference. This is a
headless integration probe; packaged installation, UI interaction, and production storage-location
configuration require separate validation before release.

Recorded evidence: Linux x86_64, Bun 1.3.14, official OpenCode/plugin/SDK 1.18.30. The complete
check passed 112 tests: 69 existing tests and 43 for this block (seven schema, 21 coordinator, and
15 real-filesystem tests). Coverage includes two competing OS processes, invalid UTF-8 and
truncated/newer documents, retained orphan locks, exclusive temporary-file collisions, uncertain
writes, stale/replayed commands, migration expansion, listener reentrancy, and noncooperative
timeouts. Type checks, core boundaries, formatting, and all four builds passed.

The stock-TUI probe passed after restarting into a second process: pins, completion, and reordered
Later entries matched exactly; the first process delivered five committed events, while hydration,
refresh, and stale-command rejection in the second process delivered none. These results do not
establish filesystem behavior on network/synchronized directories, power-loss recovery, or
rendered-sidebar performance.
