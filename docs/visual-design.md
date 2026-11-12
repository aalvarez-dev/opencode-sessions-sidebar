# Approved sidebar visual target

The approved presentation is the acceptance target for the terminal implementation. Passing
functional tests does not establish visual acceptance. Use the same synthetic design fixture on
Linux and macOS and inspect actual terminal window captures before recording a visual pass.

The source prototype is `sidebar-diseno-aprobado-opencode.html`, revision dated 2026-10-28, SHA-256
`89e1f3b983f930e3f6652fd9d0fed95a5c7ac3affe59800ae736067b1e55cfc6` (98,642 bytes). The following
contract records its product layout independently of the browser export wrapper.

## Composition

| Area                  | Required presentation                                                                                                                                                                                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Header                | `Active session:` at the left and yellow `new session +` at the right on the same line. Display management remains available from the command palette.                                                                                                                            |
| Main session title    | Independent activity/attention symbol, title, and a separate completion check. Completed titles/checks use success green without hiding activity.                                                                                                                                 |
| Main session controls | Indented pin, Later clock, yellow live-child disclosure/count when applicable, configured primary agent, age, red delete, and an ellipsis only on non-active main rows.                                                                                                           |
| Live subagents        | Compact tree branches between controls and context. One line per child: tree connector, independent activity/attention, configured agent name (session title if unavailable), and completion mark when applicable. Do not duplicate full session controls/context for each child. |
| Child defaults        | The active session's live children start expanded. Explicit expansion/collapse choices take precedence and survive selection changes for the current activation.                                                                                                                  |
| Context               | Separate yellow disclosure followed by independent `[R][B][W]` selectors and muted selected value. Expansion shows R, B, W below in that order.                                                                                                                                   |
| Active completion     | Indented `Mark completed` or `Unmark completed` followed by the completion glyph, below all expanded child/context content. No active-row ellipsis.                                                                                                                               |
| Groups                | Active first, then `Later (n)`, `Pinned sessions (n)`, `Other sessions (n)`. Counts describe displayed top-level entries after deduplication. Omit empty groups, except a Later section needed to expose unavailable saved references.                                            |
| Collapsed group       | Keep its attention/activity summary visible beside the heading when space permits. Preserve important information at constrained widths.                                                                                                                                          |
| Spacing               | Stable title/control/context alignment and separation between main sessions and groups. Compact child rows do not inherit main-session gaps.                                                                                                                                      |

Pinning, Later membership, completion and runtime state remain independent. Compact children remain
openable; Browse provides the full action set. A child promoted to Active/Later/Pinned is referenced
in the tree without duplicating its main row. Nested live descendants and unknown/error/attention
states must remain discoverable.

## Terminal translation

The browser prototype uses a 420 px panel, 13 px monospace text, approximately 21.45 px body line
height, 26 px controls, 25 px context lines, 23 px indentation, 9 px between sessions and 17 px
between groups. Terminal layout uses whole cells. Preserve composition, hierarchy, alignment and
readability; do not claim arbitrary terminal fonts or cell sizes reproduce browser pixels exactly.

The icon-rich comparison uses the pinned verified font and the Nerd catalog: recognizable pin, clock
and trash symbols with consistent expected cell widths. Unicode and ASCII are compatibility modes
and are evaluated separately; they are not visually identical replacements for vector icons. The
plugin never installs a font or changes a user's terminal profile as part of activation.

Legibility is a separate requirement from ordering the controls correctly. The Nerd catalog uses
fitted Material filled/outline pin and clock pairs, plus a stronger trash outline. The old small
horizontal inactive pin was substantially shorter than the mockup's upright pin. These replacements
fit the existing one-cell advance without changing font bytes. A circular clock remains bounded by
one cell; a terminal glyph cannot independently become a 13 px browser SVG at every font size.

Secondary row text and available, unselected controls approach 6:1 contrast against the host's
opaque panel by blending its muted color toward its normal text color. Normal text caps that target;
already readable colors remain unchanged. Terminal-controlled indexed/default colors and unknown
transparent backdrops are preserved without a contrast guarantee; their fallback RGB cannot prove
the client's actual palette. The calculation is memoized per view/theme. Configured agent and
activity/completion colors retain their host semantics. On the pinned dark fixture, this changes
gray from `#808080` to `#949494`, close to the approved prototype's `#93918d`.

The pinned host owns the sidebar width and terminal font metrics. The plugin's public content slot
does not expose a width setting. Do not force an oversized child outside that slot to mimic the 420
px prototype. Retain aligned context selectors, visible truncation and access to complete values in
Session details when the host grants fewer columns than the browser example.

Use host theme semantics for text, muted metadata, warning actions, success and errors. Agent colors
come from public host configuration. Missing agent colors or repository values are not permission to
invent data. The current exact-directory adapter reports public project/path/VCS context, not
historical per-session branches or independently discovered worktrees.

## Evidence requirements

- Capture the same four top-level synthetic sessions, memberships, completion marks, configured
  agents and live-child states on both operating systems. Retain fixture/source/plugin hashes.
- Label controlled visual-fixture inputs explicitly. Rendering the real product in stock OpenCode
  with synthetic client reads proves presentation, not native execution or transport behavior.
- Keep the independent native attention, organization, navigation and transport regressions.
- Retain original full-window PNGs and frame/geometry receipts. A panel crop is a comparison aid,
  not a replacement for the original. Do not paint, reconstruct or recolor terminal screenshots.
- Use clean captures without a dialog or toast obscuring the panel. Record unexpected warnings; do
  not erase them to obtain a visual pass.
- Check inline header, compact tree, group counts/empty-state handling, completion alignment,
  context selection/expansion, narrow widths and long labels. Check default and explicit child
  expansion separately.
- Keep host-owned title, Context, LSP and onboarding blocks outside the plugin-layout comparison.
- Record visual and functional outcomes separately from the existing resource/release gates. A
  visually matching panel does not close an outstanding memory-budget failure.

Record visual acceptance per candidate build after inspecting its actual captures; neither a
successful build nor a geometry-only receipt substitutes for that review.
