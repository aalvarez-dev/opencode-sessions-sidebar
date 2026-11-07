# Changelog

## Unreleased development build

- Space healthy global transport checks to 60 seconds, with 15-second retries after known failure
  and the existing two-second deadline. Native session events remain immediate. See the
  [quiet-health validation](docs/quiet-transport-health.md); no session cap or feature restriction.

- Window top-level group row containers with prefix heights and spacers, preserving every session
  and full-list scrolling. See [the optimization report](docs/windowed-row-containers.md) for its
  pre-cadence validation; the subsequent quiet-health results are recorded separately above.
- Keep offscreen session geometry while mounting native text buffers only near the viewport;
  preserve full-list scrolling, expanded context/children and completion ordering.
- Detect unavailable TUI HTTP transport with one bounded health check, reject stale snapshots and
  buffered activity until recovery, and reconcile without manual refresh.
- Reject malformed host identities and NUL-containing storage paths before starting project lookup.
- Extend hosted validation with complete-list scroll checks and an isolated macOS font profile.

- Preserve a centralized icon/animation catalog and expose a scrollable Check icons dialog.
- Keep custom dialogs inside the terminal viewport and isolate their navigation keys from the
  underlying session, including after resize and at scroll boundaries.
- Provide a complete pinned Iosevka Nerd Font Mono profile, offline glyph/hash verification,
  explicit user-font installation for Ubuntu/Linux and macOS, and terminal setup instructions.
- Load explicitly enabled trusted local extensions with guarded organization commands,
  session/palette actions, committed-event listeners, bounded diagnostics and scope cleanup.
- Reject unsupported automatic/custom host completion policies with an actionable explanation.
- Validate a fresh offline package installation and the installed artifact in stock OpenCode.
- Add a paired rendered-sidebar CPU/RSS comparison with predeclared budgets.
- Retain the active-session menu correction, palette visibility fix, and isolated test lab.

This is not a published V1 release. Native client font checks, supported remote/disconnect behavior,
and execution-correlated completion/report workflows remain explicit acceptance work. See
[release validation](docs/release.md) and [the roadmap](docs/roadmap.md).
