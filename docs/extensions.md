# Experimental local extensions

The development sidebar can load explicitly configured trusted JavaScript modules. Version 1 of this
experimental contract adds session menu actions, a palette entry that opens those actions, and
committed organization-event listeners. It does not establish a stable public extension API,
automatic completion reopening, native execution correlation, or a report exception to such a
policy. Those release gates remain open.

## Enable a local module

Add entries to the existing sidebar options in `tui.json`:

```json
{
  "extensions": [
    { "module": "file:///absolute/path/to/report-preview.mjs" },
    { "module": "file:///absolute/path/to/completion-observer.mjs", "enabled": false }
  ]
}
```

Use a file URL on the machine running OpenCode, including URL escaping for spaces. Only absolute
local `.mjs` or `.js` URLs are accepted; network URLs, package names, query strings and fragments
are refused. Disabled entries are not imported. There is no automatic module discovery, dependency
installation or package download. A module's own imports and code remain its author's
responsibility.

Restart the sidebar after changing modules. Files are imported once per activation, using the
runtime's normal module cache; a process restart is the reliable way to pick up edited module code.
Opening a session exposes its extra actions in the session menu. The command palette's **Sessions
sidebar: extension actions** opens the same actions for the active session, including when its row
does not have an ellipsis. A runtime predicate is checked again at invocation.

**Display settings → Extension status** shows each configured module's state and bounded diagnostic.
It identifies a loaded extension by its declared ID, or an unloaded entry by its configuration
position. Full paths, stacks and arbitrary exception messages are not shown; safe error class/code
information helps distinguish loading and callback failures. Restart OpenCode after correcting a
failed module.

These modules execute with OpenCode's process privileges. The API is a lifecycle and consistency
boundary, **not a sandbox**. Do not enable untrusted modules. The loader's asynchronous timeouts
cannot interrupt synchronous JavaScript or undo external effects.

## Contract

The default export has `apiVersion: 1`, a stable lowercase `id`, optional `actions`, and optional
`onEvent`. IDs use lowercase letters, digits and hyphens, start with a letter, and have at most 64
characters. At most eight configured modules and sixteen actions per module are accepted. Duplicate
module URLs, extension IDs, or action IDs within an extension are rejected. Action labels are at
most 100 characters and cannot contain terminal controls. Registered action IDs are namespaced as
`extension-id:action-id`.

```js
export default {
  apiVersion: 1,
  id: "manual-tools",
  actions: [
    {
      id: "pin",
      title: "Pin from extension",
      enabled: ({ session }) => session !== null,
      async run(context) {
        if (!context.session) return;
        const result = await context.dispatch({
          type: "set-pin",
          sessionId: context.session.id,
          pinned: true,
        });
        context.notify(`Pin request: ${result.status}`);
      },
    },
  ],
};
```

Action `visible` and `enabled` predicates receive an immutable snapshot and must be short,
synchronous, side-effect-free boolean functions. Missing predicates default to true. A thrown or
non-boolean predicate disables that extension. Predicates run when constructing and invoking menus;
they must not read files or make network requests.

The callback context includes:

- `session`: the selected known session's ID, title, activity and direct attention counts; event
  callbacks without a session ID receive `null`. This is not native message history.
- `scope` and `organization`: immutable scope and plugin-owned organization snapshots.
- `expectedRevision`: the action's captured document revision, or the delivered event's revision. An
  event's current organization snapshot may already be newer; its command authority still starts at
  the event revision.
- `signal`: cooperative cancellation on scope change, disposal, failure or timeout.
- `dispatch(action)`: manual pin, completion and Later commands through the existing storage
  coordinator. The runtime supplies command identity and extension origin. Extensions cannot supply
  host execution evidence. Commands targeting unknown sessions are refused.
- `notify(message)`: a bounded, sanitized local toast while the callback remains active.

Always **await** `dispatch`. Authority is revoked when the callback returns or settles, including
before detached queued writes can run. Successive awaited commands may advance from their own
acknowledged revision. A concurrent user edit returns `stale` or a storage conflict; the runtime
does not silently retry against newer state. Inspect every result. Cancellation after a storage
write starts can have an unknown outcome; follow the coordinator's refresh requirement.

## Events, failure and cleanup

`onEvent(event, context)` receives the coordinator's version-1 committed pin, completion, and Later
events. Existing state restoration and refresh do not replay actions. Extension-origin changes do
not recursively trigger these observers. Delivery is bounded and best effort, without a durable
outbox or exactly-once guarantee. External reporting must use its own idempotency, cancellation and
bounded operations.

Module loads and action callbacks have a five-second waiting limit. Organization listeners also have
the coordinator's one-second limit. A failed or timed-out callback disables that module's actions
and listener for the activation and reports a local warning; normal navigation and saved user
actions continue. A different module can keep working. Scope changes unsubscribe listeners, abort
callback signals and revoke old command contexts; late failures from an old scope do not disable the
current scope.

At most eight extension callbacks can be outstanding across project scopes. A timed-out or disposed
callback that ignores cancellation retains its reservation until the actual promise settles, so
repeated scope changes cannot accumulate unlimited work. At most eight module imports can be
pending; failed/timed-out imports are not retried on scope changes, and late import results cannot
register actions. The runtime does not create activation hooks, idle polling or background retries.

## Examples and validation

`examples/report-preview.mjs` reads a captured organization snapshot and shows a summary. It
performs no model calls, history reads, disk writes, network requests or completion changes. It
illustrates an independent report action, not the still-unavailable execution-correlated report
workflow. `examples/completion-observer.mjs` demonstrates an explicitly enabled notification
listener.

`test/extensions.test.ts` exercises local-only configuration, bounded/disabled loading, collisions,
sync/async command revocation, awaited mutations, stale user races, scope replacement,
noncooperative timeouts, event isolation and failure diagnostics. These are contract tests. The
stock-host smoke separately records actual local loading and palette/menu behavior when that probe
passes. Ubuntu and macOS native runtime/terminal compatibility must be reported for their tested
environments.
