# Session sidebar UI

This directory implements the experimental sidebar presentation and controller. `src/tui.tsx`
connects it to the stock host's sidebar and home slots, and registers command-palette actions. See
[setup and runtime evidence](../../docs/sidebar-validation.md). The package remains private.

## Presentation responsibilities

Render normalized session data and organization state from the core. Keep host SDK calls,
persistence, and optional repository reads behind their adapters. User interaction issues explicit
actions through the action boundary; JSX should not start repository workflows as a consequence of
rendering a row.

Show host activity separately from the user's completion mark. Use text or recognizable symbols as
well as color for meaningful states. Idle is not complete, and membership of Later does not mean
that execution has been scheduled.

Titles are the primary row content. Repository, branch, agent, age, and other metadata are secondary
and should degrade gracefully when unavailable. Keep labels and action availability consistent
across pointer, keyboard, and command palette access. Destructive actions must not be confused with
visual marks.

## Density on a terminal grid

Support three density choices without changing the meaning of data or actions:

| Density     | Intended spacing policy                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------------------------- |
| Compact     | No additional empty row between session entries; minimize secondary content                                                 |
| Balanced    | Keep each entry compact and use whitespace at section boundaries; distinguish entry content through hierarchy and alignment |
| Comfortable | Allow a whole empty row between entries where space permits                                                                 |

The plugin configuration supplies the initial density; Settings changes it for the current
activation. These settings do not modify terminal-wide preferences. Verify layouts at narrow widths
and limited terminal heights. Selection must remain visible, and long text must not displace the
essential status and action affordances unpredictably.

OpenTUI lays out text in terminal cells. A vertical unit is one terminal row. The current host uses
OpenTUI 0.4.5. In the separately researched OpenTUI **0.5.12** implementation, Yoga rounds layout
edges with a point scale factor of one. Passing a fractional gap does not provide uniform half-row
spacing; computed positions still land on complete cells. The text API does not offer browser-style
per-component `line-height`.

Improve separation without another empty row by using:

- A clear title/metadata hierarchy and restrained emphasis.
- Horizontal indentation and stable column alignment.
- A subtle row background or lateral marker, with adequate contrast.
- Fewer simultaneously visible secondary actions.

A horizontal border or a separator placed on its own line still uses a complete row. Half-block
glyphs draw within a cell; they do not create half a row of layout space. Do not implement
fractional padding tricks as a density mode.

Terminal-wide font or cell-height preferences belong to the user's terminal. The plugin must work
without changing them or requiring a particular emulator.

## Reactivity and lifecycle

Use the Solid transform expected by OpenTUI and the host-provided Solid/OpenTUI runtime. Do not
bundle an independent reactive runtime. Keep derived display values reactive and ensure a state
change repaints without requiring navigation away from the session.

Component and plugin disposal must release focus handlers, subscriptions, and timers. Background
reads must be asynchronous and cancelable where possible; render functions must not perform blocking
Git or filesystem work.

## Visual validation before release

Check every density with long titles, missing repository information, busy/retry states, pending
attention, completion marks, and keyboard selection. Exercise scrolling and resize, light/dark
themes, and plugin deactivation/reactivation. Core tests do not substitute for these runtime and
visual checks.

## Navigation and state ownership

The native sidebar slot is not present on every host route or terminal width. Browse is also
available from the home screen and the host command palette. Host select/prompt/confirmation dialogs
provide keyboard navigation and the same action construction used by mouse input. The sidebar does
not capture normal prompt keystrokes or add global shortcuts that conflict with host bindings.

The controller owns asynchronous project lookup, the exact-directory adapter, and organization
storage. Rendering reads normalized snapshots and current public theme/context values. No Git
provider, per-row clock, spinner interval, or metadata request runs in a render function. Completion
is manual in this integration because V1 execution correlation remains unavailable.

The default plugin owns activation. Deactivate/reactivate through the public host plugin controls;
there is no separate exported activation/disposal API that could bypass the host's slot ownership.
Display changes and collapsed groups last for the current activation. Persistent organization is
scoped separately, and another client's changes are read on explicit Refresh.

## Primary references

- [OpenTUI 0.5.12 layout documentation](https://github.com/anomalyco/opentui/blob/v0.5.12/packages/web/src/content/docs/core-concepts/layout.mdx)
- [OpenTUI 0.5.12 Yoga configuration](https://github.com/anomalyco/opentui/blob/v0.5.12/packages/native/src/yoga.zig)
- [OpenTUI 0.5.12 text options](https://github.com/anomalyco/opentui/blob/v0.5.12/packages/core/src/renderables/TextBufferRenderable.ts)
- [OpenTUI 0.5.12 box spacing options](https://github.com/anomalyco/opentui/blob/v0.5.12/packages/core/src/renderables/Box.ts)
