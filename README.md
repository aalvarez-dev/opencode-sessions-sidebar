# opencode-sessions-sidebar

An extensible sessions sidebar for OpenCode: pins, a manual **Later** list, visible activity and
attention, and customizable completion marks.

## Status

This repository is an early development foundation, **not an installable OpenCode plugin yet**. It
contains a host-independent domain model, completion-policy and Later-list behavior, and tests. The
OpenCode adapter, TUI, persistence, event delivery, and extension actions are still planned.

The first integration targets stock **OpenCode V1** through its public APIs. The minimum supported
release will be published after integration and runtime testing. A future V2 adapter can live in
this repository and share the domain model; V2 support is not currently implemented.

## Intended behavior

- Manage and navigate sessions, with pins, collapsible groups, and repository/branch context when
  available.
- Keep busy, retry, and attention indicators visible, including relevant child-session activity.
- Treat **completed** as an independent visual mark. It never archives, hides, moves, or stops a
  session.
- Support manual, automatic, and custom completion rules. The default clears the mark when new work
  starts, with explicitly correlated exceptions for custom workflows.
- Maintain an ordered, persistent **Later** list. Adding or opening an entry does not start work;
  there is no **Run all** action.
- Expose documented events and extension actions without changing what the standard completion
  action means.
- Offer readable terminal layouts and configurable density using whole terminal cells.

See the [behavior specification](docs/specification.md) for the agreed scope and the
[roadmap](docs/roadmap.md) for implementation and release gates.

The [performance and transparency requirements](docs/performance.md) define the runtime design
constraints and measurements required before release. Runtime performance has not been measured yet.

The [foundation examples](examples/README.md) demonstrate the current experimental completion
policies.

## Development

Use Bun **1.3.14**, matching the pinned project toolchain.

```sh
bun install --frozen-lockfile
bun run check
```

The check command runs formatting checks, type checks, architectural boundary checks, tests, and the
build. Use `bun run format` to apply the project's formatting rules or `bun run format:check` to
check formatting alone. There are no npm installation instructions yet: the initial build is a
development artifact, not a published plugin.

Read [CONTRIBUTING.md](CONTRIBUTING.md) before making changes. Source code, documentation, and
contributions use English.

## License

[MIT](LICENSE).
