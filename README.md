# opencode-sessions-sidebar

An extensible sessions sidebar for OpenCode: pins, a manual **Later** list, visible activity and
attention, and customizable completion marks.

## Status

This repository contains development libraries, **not an installable OpenCode sidebar yet**. The
portable core implements completion policies and the manual Later list. The headless V1 adapter adds
scoped session snapshots, incremental activity/attention, descendant summaries, lifecycle cleanup,
and native session actions. TUI rendering, persistence, the public extension event bus, and
extension actions remain planned.

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
constraints and measurements required before release. The component probe measures the adapter
without rendering; it does not establish terminal latency or stock-OpenCode process overhead.

See [V1 adapter validation](docs/v1-adapter-validation.md) for the exact scope, reproducible checks,
and outstanding compatibility gates. The adapter does not infer execution starts from busy or
message events, so automatic completion reopening is not wired to this host yet.

The [foundation examples](examples/README.md) demonstrate the current experimental completion
policies.

## Development

Use Bun **1.3.14**, matching the pinned project toolchain.

```sh
bun install --frozen-lockfile
bun run check
bun run benchmark:v1
```

The check command runs formatting checks, type checks, architectural boundary checks, tests, and the
build. Use `bun run format` to apply the project's formatting rules or `bun run format:check` to
check formatting alone. There are no npm installation instructions yet: the initial build is a
development artifact, not a published plugin.

The core and headless adapter compile to separate ESM entrypoints. OpenCode SDK/plugin packages are
development dependencies for public type checking and test harnesses; the built adapter does not
import or bundle the OpenCode, Solid, or OpenTUI runtimes.

Read [CONTRIBUTING.md](CONTRIBUTING.md) before making changes. Source code, documentation, and
contributions use English.

## License

[MIT](LICENSE).
