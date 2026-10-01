# Experimental sidebar validation

The development TUI entrypoint targets stock OpenCode **1.18.30**. This is one tested baseline, not
a minimum-version or V2 compatibility claim. The package remains private; public release and
packaged-installation validation are separate roadmap work.

## Load the local development build

Build this checkout with Bun 1.3.14 (`bun install --frozen-lockfile && bun run build`). Add the
built entrypoint to OpenCode's documented `tui.json` plugin configuration, using paths on the
computer running the TUI:

```json
{
  "plugin": [
    [
      "file:///absolute/path/to/checkout/dist/tui.js",
      {
        "hostId": "example-local-host",
        "storageDirectory": "/absolute/path/to/private/sidebar-state",
        "density": "balanced",
        "icons": "ascii"
      }
    ]
  ]
}
```

Choose a stable `hostId` for this OpenCode server and a private, absolute **local** storage
directory. Keep the identity stable across ordinary restarts; use a different identity for a
different server. Neither a temporary server port nor credentials make a suitable identity.
Host-reported directories may belong to a remote server and are never used as local storage paths.
The public project API supplies the project identity. See
[storage and events](storage-and-events.md) for concurrency, uncertain writes, migration, and
orphan-lock recovery.

`density` accepts `compact`, `balanced`, or `comfortable`; `icons` accepts `ascii` or `unicode`.
This is a development checkout procedure, not an npm release or an invitation to change the host's
private storage. Keep the package private until the separate release gates pass.

## Use the sidebar

Open the host command palette (Ctrl+P with the stock bindings) and choose **Sessions sidebar:
browse**, **create session**, **refresh**, or **settings**. Browse is also available on the home
screen and in the sidebar. Selecting a row opens the same actions menu with either mouse or
keyboard. Delete requires the host confirmation dialog; marking complete is an independent visual
action.

Pinned, Later, and All sessions can be collapsed. Their summaries retain known descendant activity
and attention. Browse is the fallback when the native sidebar is absent, including narrow terminals
and child-session routes. Short activity/attention labels precede optional title context, and the
session actions dialog shows the full status. A displayed question mark means unknown coverage or
activity, not confirmed idle.

Use **Manage Later list** to open, reorder, or remove saved entries. Missing entries remain visible
as unavailable references because absence from a partial or different-directory snapshot does not
prove deletion. Settings also exposes removal of unavailable pins. A confirmed native deletion
retains annotations until explicit cleanup; that cleanup is a manual organization action.

Display settings and collapsed groups last for the current activation; put initial density/icon
choices in `tui.json`. Pins, completion marks, and Later order use the persistent organization
backend. Use Refresh to read changes made by another client; there is no background file polling.
Browse freezes its membership, title order, and action targets while open, keeping live status
labels, so a host update cannot move keyboard selection to a different session. Reopen it for a new
list.

The controller reacts to public directory changes and rejects callbacks captured in an older scope.
The V1 public API has no workspace-change observer; an optional `workspaceId` is fixed for an
activation. Changing it requires reactivation. Automatic completion reopening and custom workflows
remain unavailable in this host integration because reliable execution correlation is unproven.

## Shared host runtime

The TUI is compiled with the OpenTUI Solid transform. `solid-js`, `solid-js/*`, `@opentui/core`,
`@opentui/solid`, `@opentui/keymap`, and their subpaths remain external. The build inspects its
input graph and rejects bundled host runtimes. The headless libraries remain separate entrypoints.
Development types match the host's OpenTUI 0.4.5 and Solid 1.9.10 dependencies. OpenTUI's npm
package declares a newer Solid peer; the actual host supplies the reactive runtime during
validation.

## Runtime procedure and predeclared budgets

Run `bun run check`, then:

```sh
OPENCODE_BIN=/absolute/path/to/opencode bun run smoke:sidebar
OPENCODE_BIN=/absolute/path/to/opencode bun run smoke:sidebar:attention
bun run benchmark:sidebar
```

Use an isolated POSIX pseudo-terminal and official OpenCode 1.18.30 with temporary configuration,
synthetic sessions, plugin-owned storage, and no inherited provider credentials. The harness must
exercise real terminal input and inspect rendered cells, rather than count dispatch calls as proof
that a user-visible update occurred. Do not describe a synthetic state fixture as an actual host
permission, question, or retry event.

The following focused budgets are fixed before the first sidebar measurement:

| Workload                                                                                | Budget                                                    |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Navigation/input to observed rendered frame (including observer IPC and snapshot reads) | p95 at most 250 ms                                        |
| A burst of 500 synthetic updates                                                        | at most 500 ms, with zero additional full-list host reads |

The observer budget includes file IPC and host snapshot reads, so it is a conservative end-to-end
measurement, not renderer-only paint latency. The 250 ms budget was chosen before the first
measurement to include that observation cost. These are development smoke budgets, not a
statistically established service level. Record sample counts, exact workloads, hardware, versions,
and any failed budget. The controlled CPU/RSS baseline in [performance](performance.md) covers the
previous headless adapter; it must not be reused as evidence of rendered-sidebar overhead. Broader
packaged-release performance validation is pending.

## Required correctness evidence

- Native create/open/rename and explicitly confirmed delete through the shared action path.
- Independent completion, pin, and Later membership/order, including recovery from persisted state.
- Mouse and keyboard access, narrow and wide layouts, scrolling/resize, light/dark colors, density,
  and a text/ASCII alternative to optional glyphs.
- Busy/retry and parent/descendant attention remain discoverable with a completion mark and with
  groups collapsed. Unknown coverage remains explicit.
- No local repository probes or optional metadata requests in rendering; delayed metadata does not
  hold navigation. No prompt is submitted by organization actions.
- Deactivation/reactivation releases owned subscriptions and controls, and stale asynchronous work
  cannot update a newer or disposed scope.

## Recorded results

The focused probes passed on Linux x86_64 with Bun 1.3.14, official OpenCode 1.18.30, OpenTUI 0.4.5,
and the host Solid 1.9.10 runtime. The [input/render report](validation/sidebar-runtime.json)
records hardware, exact source and built-artifact digests, 12 checks, and seven actual
captured-frame scenarios. Mouse and keyboard CRUD, cancel/confirm delete, organization, Later
reorder, long-list scrolling, 140×40 and 88×24 layouts, ASCII/Unicode labels, verified light/dark
host modes, restart, and host deactivation/reactivation passed. Captured colors and text were
visually inspected.

| Probe                                                                              | Observed result                                        | Predeclared budget           |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------- |
| Keyboard input to observed rendered frame                                          | p95 98.89 ms, ten samples                              | ≤250 ms                      |
| Twenty paced native session updates                                                | 625.32 ms; three keyboard samples overlapped the burst | ≤5,000 ms                    |
| Reactive controller: 250 sessions, 500 activity changes and 500 inert token events | 132.97 ms total; zero extra SDK reads                  | ≤500 ms and zero extra reads |

The native update fixture deliberately spaces requests by 10 ms; this is a responsiveness smoke, not
unpaced throughput. Observer IPC and public snapshot reads are included in the keyboard timing. Ten
samples on shared hardware do not establish a statistical latency guarantee.

The [controller report](validation/sidebar-component.json) uses synthetic public host ports and real
Solid reactivity, without a terminal or OpenCode process. It records exactly 500 changed row
identities, no recomputation from token events, and zero retained instrumented subscriptions or
lifecycle callbacks after disposal. The cache keeps unaffected row identities stable and avoids
sorting on activity-only changes. These measurements do not establish whole-process overhead.

The [native attention report](validation/sidebar-attention.json) uses three deterministic loopback
provider responses, with no external model inference. Native child busy/question, question reply,
permission, permission reply, and idle were rendered while the parent remained marked and pinned;
the collapsed All sessions summary kept attention visible. At 88×24, Browse retained the mark and
question footer, and the actions menu retained the full busy/question labels. The narrow inspection
uses a separate idle current session: when viewing the session that owns a native question, the
host's attention UI takes keyboard priority. The plugin does not override that priority.

Model/controller tests cover retry and unknown labels, descendant aggregation without double
counting, cached row identity, actual local organization initialization/persistence, old-scope
callbacks, late native results after disposal, and bounded noncooperative project lookup. Native
retry rendering, a real remote server/disconnect, a deliberately stalled optional metadata provider,
and cross-platform terminal rendering remain unverified. There is no optional metadata provider in
this build; it displays available public context without initiating enrichment requests. All three
density choices use integer cell spacing, but an exhaustive density-by-theme visual matrix remains
part of release validation.

Independent source review found and resolved ownership, stale-action, hidden-attention, and
whole-list remount issues. The source review, model tests, real-host correctness probes, and limited
performance workloads are complementary evidence; none substitutes for the pending packaged-release
gates.
