# Sessions sidebar specification

This is the agreed product direction. It is **not a list of currently available features or a
released extension API**. The repository implements the host-independent foundation and a headless
V1 adapter described in the README. A manual organization coordinator now adds local persistence and
experimental events as described in [storage and events](storage-and-events.md). An experimental TUI
now connects these boundaries; see [sidebar validation](sidebar-validation.md). Stable extension
delivery and public release remain subsequent work, and one tested host version does not establish a
compatibility range.

## Product and compatibility

Provide an independent sidebar plugin for stock OpenCode V1 using public APIs. Installation requires
only stock OpenCode and documented dependencies. Optional integrations are configured separately.

The domain model is shared. OpenCode V1 integration belongs in its own adapter. A future V2 adapter
may share this repository, with separate entry points or packages if dependency and loading
requirements make that necessary. Do not assume the UI or every host capability is portable. Declare
a minimum OpenCode version only after validating the actual integration.

## Sessions and visibility

Support opening, creating, renaming, and deleting sessions; pins; collapsible groups; and
repository/branch context where the host or an optional read-only provider can establish it. Keep
activity labels faithful to the host, such as busy, retry, and idle. Unknown or disconnected status
must not be displayed as confirmed idle.

Completion, pinning, Later membership, activity, and attention are independent state dimensions.
Completion must never archive, hide, move, unpin, stop, or change focus away from a session. A
completed session can still be busy, retrying, or awaiting permission or an answer. The UI must show
these facts together. Child-session activity and attention must remain discoverable from their
parent; collapsed groups need an attention summary.

Do not infer remote repository state by running Git in an unrelated local directory. Missing context
is acceptable. Host operations remain host responsibilities; the plugin observes their outcomes
rather than maintaining a competing execution engine.

## Completion mark

The standard action toggles a visual mark. It does not run a report or finish a host execution.
Never infer completion from idle, an assistant response ending, or a successful tool invocation.

Offer three policies:

| Policy             | Meaning                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Manual             | Only an explicit user or extension request changes the mark.                                                        |
| Automatic, default | A newly detected execution clears the mark, except for an explicitly matched workflow exception.                    |
| Custom             | A user-supplied rule can keep, set, clear, or delegate to the default decision using the event and current context. |

Policy evaluation decides state changes. Post-change event listeners perform optional side effects.
Keep those mechanisms separate: generating a report must not block the mark from appearing, and
failure of a listener must not undo it.

### Causality and concurrency

- A repeated busy notification is not necessarily a new execution. Changing retry state or
  refreshing metadata does not by itself reopen a session.
- A mark applied during an existing execution survives further notifications from that same
  execution. Subsequent new work is evaluated separately.
- Read-only history access or an export does not constitute new session execution.
- An extension may identify its own operation and request a configured completion exception.
  Preserve the mark only for events that can be associated with that operation.
- The foundation requires a workflow ID and name, the completion event that caused it, and the
  matching mark revision for a preservation claim. A matching workflow name alone is insufficient.
  The future adapter must establish the association to observed execution events.
- A concurrent user task must still follow its own policy. Do not use a session-wide suppression
  flag, an arbitrary time window, or “ignore the next busy event.”
- Where the host lacks sufficient correlation, do not invent it. The adapter must distinguish
  confirmed new execution from unknown activity; a detected new execution without a proven exception
  uses the general rule.
- Use event identity and domain revisions to reject duplicate or stale transitions. An old report
  completing must not overwrite a newer manual choice or remark a session reopened by later work.
- Policies may change completion behavior, but cannot suppress runtime or attention indicators.

The concrete policy API is experimental until the adapter demonstrates which causal information the
host can reliably provide. The core must accept explicit inputs rather than fabricate host run
identifiers.

## Later list

Later is an ordered manual list of sessions, not an execution queue.

- Add, remove, and reorder entries; persist membership and order when storage is implemented.
- Do not duplicate the same session in the same list.
- Opening an entry does not execute it or automatically remove it.
- Marking a session completed, pinning it, or receiving an idle event does not alter Later
  membership.
- There is no Run all action, scheduler, or automatic queue drain.
- Removing a deleted session reference is cleanup, not execution; report its reason in the
  corresponding event.

An external extension can implement different workflows through explicit APIs. Such behavior is
optional and must not silently change these defaults.

## Events and extensions — proposed contract

Domain events belong to this plugin. They must not be presented as arbitrary events that OpenCode's
own typed event bus accepts. The adapter translates supported host events into domain inputs;
extensions subscribe through the plugin API.

The proposed versioned envelope contains:

| Field                          | Purpose                                                                                      |
| ------------------------------ | -------------------------------------------------------------------------------------------- |
| `id`, `version`, `type`        | Event identity, schema version, and event name.                                              |
| `scope`, `sessionId`           | Host/project scope and session identity when applicable.                                     |
| `revision`                     | Committed revision for the relevant state; not a host execution number.                      |
| `before`, `after`              | Minimal immutable values describing a state change, where applicable.                        |
| `reason`, `origin`             | Why it happened and whether it came from a user action, host, policy, extension, or cleanup. |
| `correlationId`, `causationId` | Optional operation and triggering-event references, only when known.                         |
| `occurredAt`                   | Timestamp for diagnostics, not the authority for ordering.                                   |

The payload varies by type. These names and fields are proposed and require contract tests before
becoming a stable public API.

### Transition results and delivered events

The core returns immutable transition descriptions; it does not allocate public event IDs,
timestamps, or deliver notifications. The organization coordinator owns that envelope and the
applicable commit guarantee for the implemented manual changes. The broader host and extension
integration remains planned. Its mapping is explicit:

| Current transition result                  | Proposed delivered event     | Mapping                                                                          |
| ------------------------------------------ | ---------------------------- | -------------------------------------------------------------------------------- |
| `completion.changed`                       | `session.completion.changed` | Allocate a new envelope `id`; use `change.causedByEventId` as its `causationId`. |
| `queue.changed` with `action: "added"`     | `queue.added`                | Add envelope identity and the coordinator's initiating action context.           |
| `queue.changed` with `action: "removed"`   | `queue.removed`              | Include the initiating action or cleanup reason.                                 |
| `queue.changed` with `action: "reordered"` | `queue.reordered`            | Describe the resulting order once per actual change.                             |

An input can cause multiple state changes. Its identity is a causal reference, not a unique ID for
each delivered event. Consumers must deduplicate delivered events by their envelope `id`, not by
`causationId`. No-op transition results do not create change events.

The core's `markEventId` and workflow `causedByEventId` refer to the input that established the
current mark, together with its revision. They are not public envelope IDs. The future coordinator
must preserve or explicitly map that causal reference when exposing workflow helpers; extensions
must not have to guess an association from names or timing. This mapping needs contract tests before
event subscriptions become public.

### Proposed event families

| Event family               | Proposed events                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Session facts              | `session.created`, `session.selected`, `session.renamed`, `session.deleted`                                         |
| Independent state          | `session.pin.changed`, `session.completion.changed`, `session.context.changed`                                      |
| Execution and attention    | `session.execution.started`, `session.activity.changed`, `session.attention.changed`                                |
| Plugin-initiated actions   | `session.action.requested`, `session.action.succeeded`, `session.action.failed` with action and request identifiers |
| Later list                 | `queue.added`, `queue.removed`, `queue.reordered`                                                                   |
| Presentation and lifecycle | `group.collapsed.changed`, `settings.changed`, `plugin.ready`, `plugin.disposed`                                    |

Emit facts only after successful state transitions, once per actual change.
Requested/succeeded/failed describe plugin-initiated commands and must not be confused with
host-observed facts. Repaints, spinner ticks, and unchanged values do not produce domain changes.

Listeners run outside policy evaluation, are isolated from one another, and support disposal. An
error is observable but does not roll back committed UI state. The initial system is not a durable
workflow engine and does not promise exactly-once delivery or replay after restart. Extensions
needing reliable external effects must persist and deduplicate their own work.

Extensions use explicit mutation APIs; they do not receive mutable access to the store. Guard
against re-entrant loops and stale writes. Examples must cover registration, cleanup, error
reporting, and preserving a mark during a correlated report operation.

### Additional actions

An extension can propose an action with a stable namespaced ID, label, visibility/enabled
conditions, and a handler. Actions appear in the session menu and, where host APIs allow, the
command palette. Example: **Generate report** can run independently of **Mark completed**. An
optional completion listener can invoke that same workflow automatically.

Do not add a permanent row button for every extension action. Standard completion remains a simple
mark, with custom behavior configured explicitly. Public API details and palette support remain
subject to adapter validation.

## Storage and UI

Persist plugin-owned state through a storage interface, scoped to the appropriate
host/project/session identity. Do not edit OpenCode's private session files. Define schema versions
and migrations before releasing persistent formats. Loading or reconnecting restores snapshots
without replaying user actions or launching extension side effects.

Use theme colors, accessible labels, keyboard and mouse navigation, and an icon fallback. Keep title
and secondary metadata visually distinct. Retain important attention/activity information when width
is constrained; move secondary actions into the session menu.

Terminal layout uses whole cells. Do not promise half-row interline spacing from fractional padding.
Plan compact, balanced, and comfortable density settings; use grouping, indentation, and subdued
backgrounds for the balanced layout, with explicit whole-row gaps where appropriate. Terminal-wide
cell-height preferences are optional user settings, not changes made by this plugin.

### Continuista presentation

Keep the terminal-native two-line row: an independent activity/attention icon and title, then
subdued organization controls and available context. A completed title and its separate check use
success green. Creation and Mark/Unmark completed actions use warning yellow. Inactive pin/Later
controls use subdued gray and a different glyph from their normal-text active counterparts.

The active session stays at the top, followed by Later, Pinned sessions, and Other sessions. Display
full rows once with that priority without changing their independent saved memberships. A row opens
the session directly; its ellipsis opens the shared actions menu. Delete retains native
confirmation. Move display management into the header menu and palette rather than a permanent
toolbar.

A parent with children has a third line: disclosure, actual child count, and `[agent]` names. Use
the public configured agent color when available, otherwise muted gray. Expanding exposes child
rows; a child promoted to Active/Later/Pinned is referenced without duplicating its full row.
Malformed parent cycles must not hide sessions or recurse indefinitely. Collapsed groups and parents
retain known activity, attention, error, and uncertainty summaries.

Questions and permissions use yellow; retry uses an orange tone derived from the host palette.
Reserve the red cross for an observed non-abort failure followed by confirmed idle, not a retry or a
lost connection. Busy and idle use normal text color. Unknown is a fixed neutral outline; a
three-point checking animation is only valid during an actual in-flight refresh. Use one shared,
visibility-bound animation clock and offer reduced motion and ASCII fallbacks. No idle polling or
per-row metadata request is required for this presentation.

## Out of scope for the first release

External workflow orchestration, autonomous execution, Run all, scheduling, service-specific
integrations, a durable automation engine, and an unvalidated V2 adapter. The sidebar may expose
events that independent extensions use to implement such workflows.
