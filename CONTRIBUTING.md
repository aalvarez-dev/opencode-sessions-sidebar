# Contributing

This project is establishing its domain model before connecting it to OpenCode. Read the
[specification](docs/specification.md) and [roadmap](docs/roadmap.md) first. Changes should describe
whether they implement an agreed behavior or propose a change to it.

## Local workflow

1. Install Bun 1.3.14.
2. Create a focused branch from `main`.
3. Run `bun install --frozen-lockfile`.
4. Make the change and run `bun run check`.
5. Open a pull request with the problem, behavior change, verification, and remaining limitations.

Keep source code, documentation, comments, and pull requests in English. Commit the lockfile when
dependencies change. Do not claim a supported OpenCode version or a passing runtime scenario based
only on a build or a unit test.

## Boundaries

- Keep completion policies, pins, and Later-list rules independent of OpenCode, Solid, terminal
  rendering, shell commands, and filesystem access.
- Put host-specific behavior behind an adapter and plugin storage behind a storage interface.
- Do not edit OpenCode's private session files or depend on private application internals.
- Keep personal automation and service-specific integrations outside the core.
- Do not publish packages, create releases, or change repository settings as part of an unrelated
  implementation change.

## Tests and review

Test externally meaningful behavior, especially completion/activity coexistence, duplicate events,
stale operations, queue ordering, and persistence boundaries when introduced. Include regression
coverage for a fixed behavioral defect. Avoid tests that only restate implementation details.

Any TUI or host-adapter change needs the relevant runtime checks from the roadmap, in addition to
`bun run check`. Report tests that could not be run. Changes to the planned extension API should
include an example and explain ordering, errors, disposal, and compatibility.

Preserve license notices and attribution when reusing code. Contributions are made under this
repository's MIT license.
