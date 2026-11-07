# Sidebar examples

The packaged `report-preview.mjs` and `completion-observer.mjs` modules use the experimental local
extension contract. Enable them explicitly as described in [extensions](../docs/extensions.md). The
report action only previews captured organization data; it does not start model work or alter
completion. The observer illustrates notifications after acknowledged manual changes.

## Source-only completion policies

[`completion-policy.ts`](completion-policy.ts) shows manual, report-preserving, and custom policies
using the current experimental domain API. It is type-checked with the project. These objects are
not yet installable OpenCode configuration.

A policy synchronously decides whether to mark, clear, keep, or use the default decision. Starting a
report belongs in a separate post-change hook. The local extension coordinator now delivers manual
organization events, while the execution-correlated report workflow remains unavailable. The policy
itself must not call the model, write files, or launch work. This TypeScript foundation example is
available in the source checkout, not the packaged JavaScript examples.

`preserveFor` requires verified causal context from the adapter, including the workflow identity,
triggering mark event, and matching revision. It is not an instruction to ignore other activity in
the session. A concurrent independent user execution still follows its own policy.

Unknown origin does not match `reopenForUserWork`. That is a deliberate choice in this example, not
the default policy: the default clears a mark for any confirmed new execution without a matching
preservation exception.
