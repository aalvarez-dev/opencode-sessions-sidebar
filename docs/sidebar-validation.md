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

`density` accepts `compact`, `balanced`, or `comfortable`; `icons` accepts `ascii`, `unicode` (the
default), or `nerd` (requires a compatible Nerd Font). Set `reducedMotion: true` for static activity
indicators. Display settings can change these options for the current activation. This is a
development checkout procedure, not an npm release or an invitation to change the host's private
storage. Keep the package private until the separate release gates pass.

## Use the sidebar

Open the host command palette (Ctrl+P with the stock bindings) and choose **Sessions sidebar:
browse**, **create session**, **refresh**, or **settings**. Browse is also available on the home
screen and in the sidebar header menu. Clicking a session title opens it directly; the row ellipsis
opens its actions. Keyboard Browse opens the same actions. Quick pin/Later controls retain
independent memberships; delete requires the host confirmation dialog.

The active session is followed by Later, Pinned sessions, and Other sessions, in that display
priority. A session has only one full row. Its first line contains the independent status indicator,
title, and completion check. The second line contains pin/Later controls, a yellow live-subagent
count and disclosure when relevant, the session's primary agent, age, red delete, and actions menu.
Confirmed idle descendants are excluded from that live count; uncertain activity remains visible.
Expanding live subagents inserts their rows immediately after the controls and before the parent's
context line. Explicitly promoted children retain a link to their row's group. Configured public
agent colors are used when available; unknown colors stay gray.

The third line contains a separate yellow context arrow and **[R][B][W]** selectors for repository,
branch, and worktree. Selecting a field changes only the inline value; it does not expand context.
The arrow expands the three values in the same R/B/W order below that line. **Context: show
repository/branch/worktree** and **Expand/Collapse context** in the shared session menu provide the
keyboard equivalent. **Session details**, also opened by clicking a context value, exposes full
values in a scrollable dialog with Up/Down or PgUp/PgDn and Esc to close. Missing public context is
shown as unavailable; no metadata enrichment requests run while rendering.

Repository means the root reported by OpenCode's public project API. OpenCode 1.18.30 preserves the
first worktree discovered for that project; when a fresh host first opens a linked worktree,
Repository and Worktree may therefore report the same path. The plugin does not infer the main Git
checkout by reading `.git` or running local commands. The distinct-context runtime fixture first
opens the main checkout through stock OpenCode, then opens its linked worktree with the same
isolated host state.

Marking a session completed turns its title and separate check green. **Mark completed** and
**Unmark completed** remain yellow and always appear below everything expanded in the active row,
including its subagents and context. The mark never overrides activity or attention. Settled child
errors remain discoverable through the parent's status and summaries after the child leaves the live
list. Native delete still requires confirmation.

Collapsed groups and parents keep compact descendant activity/attention/uncertainty summaries.
Questions and permissions are yellow, retry is orange, and a red cross requires an observed
non-abort error followed by idle. Historical failures cannot be recovered from list/status snapshots
after restarting. Unknown activity is a fixed neutral outline (ASCII `?`); animated checking
requires an actual in-flight refresh. Busy and checking share one visibility-bound clock, released
when the view disappears. ASCII checking is static `...`; reduced motion freezes both animations.

Browse is the fallback when the native sidebar is absent, including narrow terminals and
child-session routes. The session actions dialog retains full status and coverage details. Known
local context is displayed from the exact-directory public host state; it does not imply execution
correlation or support for arbitrary remote repository metadata.

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

## Current context-and-controls revision

The updated probes passed on Linux x86_64 with Bun 1.3.14 and official OpenCode 1.18.30, using
isolated temporary host state and synthetic data. The
[current input/render receipt](validation/sidebar-context-runtime.json) records 14 checks and ten
captured frames. It verifies distinct public repository/worktree paths in a linked checkout, mouse
and keyboard R/B/W selection without expansion, separate context expansion, completion below
expanded context, and full-value details. At 88×24, Down, PgDn, PgUp, and Esc operate the details
dialog, with every character of the wrapped branch retained outside the scrollbar column. CRUD,
organization, restart, light/dark modes, and ASCII/Unicode checks also pass.

The [current native attention receipt](validation/sidebar-context-attention.json) records nine
checks and ten frames from five deterministic loopback provider requests, with no external
inference. Actual retry, child question and permission, resolved idle, and settled error are visible
independently of completion. Expanded parents use an aggregate status glyph; collapsed groups retain
textual counts. Mouse and keyboard disclosure show live children between controls and parent
context. The active parent's completion action stays below both expanded children and context.
Settled children leave the live count, while their errors remain visible through the parent.
Switching to the newly created current session also exercises route reconciliation.

| Current probe                                                                      | Observed result                         | Unchanged budget             |
| ---------------------------------------------------------------------------------- | --------------------------------------- | ---------------------------- |
| Keyboard input to observed frame                                                   | p95 110.56 ms, ten samples              | ≤250 ms                      |
| Twenty paced native updates                                                        | 679.05 ms; two keyboard samples overlap | ≤5,000 ms                    |
| Reactive controller: 250 sessions, 500 activity changes and 500 inert token events | 214.25 ms; zero extra reads             | ≤500 ms and zero extra reads |

Both native probes captured source and built-artifact hashes before launch and verified they were
unchanged at completion. The [current controller receipt](validation/sidebar-context-component.json)
records zero token-driven recomputations and zero retained instrumented subscriptions or lifecycle
callbacks after disposal. Its source hashes were recorded immediately afterward and agree with the
overlapping native receipts. The
[ordered input diagnostics](validation/sidebar-context-input-diagnostics.json) preserve every timing
sample. Ten samples on shared hardware still do not establish stable tail latency or whole-process
resource overhead.

The [attempt history](validation/sidebar-context-attempts.json) separates outdated harness
expectations, the sandbox's initial loopback-bind refusal, the cold-linked-project observation, and
the final passes. Visual inspection found and corrected a scrollbar covering one branch character;
the final narrow test asserts the complete value. Rendered-cell captures of the final wide context
and narrow details were visually inspected. The historical receipts below describe the prior
presentation and remain historical evidence, not proof for this source revision.

## Historical source baseline

The preceding presentation's focused probes passed on Linux x86_64 with Bun 1.3.14, official
OpenCode 1.18.30, OpenTUI 0.4.5, and the host Solid 1.9.10 runtime. The
[input/render report](validation/sidebar-runtime.json) records hardware, exact source and
built-artifact digests, 13 checks, and seven actual captured-frame scenarios. Mouse and keyboard
CRUD, cancel/confirm delete, organization, Later reorder, long-list scrolling, 140×40 and 88×24
layouts, ASCII/Unicode labels, verified light/dark host modes, restart, and host
deactivation/reactivation passed. Captured colors and text were visually inspected.

| Probe                                                                              | Observed result                                        | Predeclared budget           |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------- |
| Keyboard input to observed rendered frame                                          | p95 206.75 ms, ten samples                             | ≤250 ms                      |
| Twenty paced native session updates                                                | 1,557.44 ms; two keyboard samples overlapped the burst | ≤5,000 ms                    |
| Reactive controller: 250 sessions, 500 activity changes and 500 inert token events | 364.68 ms total; zero extra SDK reads                  | ≤500 ms and zero extra reads |

The native update fixture deliberately spaces requests by 10 ms; this is a responsiveness smoke, not
unpaced throughput. Observer IPC and public snapshot reads are included in the keyboard timing. Ten
samples on shared hardware do not establish a statistical latency guarantee.

Earlier runs failed the unchanged 250 ms input budget: one while both native probes ran in parallel
(the prior assertion did not retain its exact p95), and a subsequent isolated run at **842.87 ms**.
The isolated sorted samples were 117.79, 131.69, 151.27, 152.83, 155.78, 156.85, 203.05, 218.06,
254.02, and 842.87 ms. Adding per-observation timing, with no product change, produced the recorded
206.75 ms pass. Its two overlapping-burst samples were 162.57 and 144.99 ms; its slowest samples
occurred after the burst. The
[ordered input diagnostic receipt](validation/sidebar-input-diagnostics.json) separates SDK/storage
time from round-trip observation time. The earlier spike's cause remains unresolved: this final pass
does not establish stable tail latency or justify a hardware-only explanation. Keep repeatability
and broader performance analysis in the release gate.

The initial uncached hierarchy draft also exceeded the 500 ms component budget at 552.59 ms. The
final model caches parent topology and the recorded component run passed at 364.68 ms. These
measurements are development observations on shared hardware, not an isolated causal benchmark.

The [controller report](validation/sidebar-component.json) uses synthetic public host ports and real
Solid reactivity, without a terminal or OpenCode process. It records exactly 500 changed row
identities, no recomputation from token events, and zero retained instrumented subscriptions or
lifecycle callbacks after disposal. The cache keeps unaffected row identities stable and avoids
sorting on activity-only changes. These measurements do not establish whole-process overhead.

The [native attention report](validation/sidebar-attention.json) uses five deterministic loopback
provider requests, with no external model inference. Native retry (recoverable 429), child
busy/question, question reply, permission, permission reply, idle, and a settled error (400) were
rendered while the parent remained marked and pinned; the collapsed Pinned sessions summary kept
attention visible. Third-line child disclosure was expanded/collapsed through real mouse input, with
an additional Unicode capture. The final error rendered a red cross while the completed parent
retained its green title and check. Retry color was checked on the collapsed parent summary; the
expanded retry glyph itself was not asserted. At 88×24, Browse retained the mark and question
footer, and the actions menu retained the full busy/question labels. The narrow inspection uses a
separate idle current session: when viewing the session that owns a native question, the host's
attention UI takes keyboard priority. The plugin does not override that priority.

Model/controller tests cover group priority without duplicate full rows, cycle/orphan reachability,
retry/error/unknown labels, descendant aggregation without double counting, cached row identity,
actual local organization initialization/persistence, old-scope callbacks, late native results after
disposal, and bounded noncooperative project lookup. A real remote server/disconnect, a deliberately
stalled optional metadata provider, and cross-platform terminal rendering remain unverified. There
is no optional metadata provider in this build; it displays available public context without
initiating enrichment requests. All three density choices use integer cell spacing, but an
exhaustive density-by-theme visual matrix remains part of release validation.

Motion tests cover three-dot frames, a single shared clock, scroll/ancestor clipping, reduced
motion, and cleanup. They establish scheduler behavior, not whole-process idle CPU. The optional
Nerd Font glyph set still requires an appropriate terminal font; ASCII and Unicode were exercised in
the native probes.

Independent source review found and resolved unknown/error summaries, promoted-child references,
cumulative indentation, and completion-action placement above expanded children. The source review,
model tests, real-host correctness probes, and limited performance workloads are complementary
evidence; none substitutes for the pending packaged-release gates.
