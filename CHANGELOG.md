# Changelog

## Unreleased development build

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
