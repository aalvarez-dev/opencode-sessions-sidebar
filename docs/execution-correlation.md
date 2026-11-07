# Completion policy capability in OpenCode V1

The portable core implements manual, automatic, and custom completion policies. The current OpenCode
adapter connects **manual marking only**. Automatic reopening and correlated workflow exceptions
remain implementation and release gates, not merely unchecked configuration options.

The adapter entrypoint exports `v1CompletionCapabilities`. It reports the researched host version,
manual support, unavailable automatic/custom host policies, and the reason. Sidebar configuration
may explicitly set `completionPolicy: "manual"`; omitting the option preserves current behavior.
Requests for `automatic`, `on-execution`, or `custom` produce an actionable configuration error
instead of being silently ignored. This does not remove those policies from the intended product
scope or disable the portable core's existing policy functions.

## Pinned source evidence

This review used OpenCode **1.18.30**, tag commit `3104c1428ec91f809e5ab86631300de41eb6952e`. Source
inspection is evidence of the host implementation; it is not a successful automatic-completion
runtime test.

| Candidate signal                                 | Why it cannot establish the required execution boundary                                                                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A new user message                               | `prompt()` calls `createUserMessage()` before checking `noReply`. A public request can therefore create a user message without starting work.                                   |
| `session.status: busy`                           | `runLoop()` publishes busy on every loop iteration. The public status contains no run identity; a duplicate or another model/tool step is not necessarily a new user execution. |
| A new assistant message                          | An ordinary assistant message is created after busy, history/model/agent work, and reminder processing. Its creation is later than the execution starting.                      |
| `assistant.parentID`                             | This identifies the parent user message. Multiple assistant/tool steps can share that parent. It does not identify a distinct host execution or its ordered start boundary.     |
| A message timestamp or ascending identifier      | Neither supplies the verified execution order across retries, reconnects, multiple clients, and restarts required by the completion frontier.                                   |
| `idle`, a finished message, or a successful tool | These are activity or message outcomes. They do not certify completion of the user's task and must not set the visual mark.                                                     |

The same host also creates assistant messages for explicit shell operations and subtasks. A new
assistant message is therefore not synonymous with one new model invocation or user turn.

The public `message.updated` event contains a session ID and message. Its event ID can deduplicate
delivery, but is not a run identifier. `UserMessage` does not retain the request's `noReply` flag;
`AssistantMessage` contains `parentID` and creation/completion times but no execution identifier.
The TUI API exposes these host events without a separate confirmed execution-start subscription.

## A concrete race that a heuristic would get wrong

1. A user starts work. The host reports busy.
2. While that same work is already running, the user marks the session complete.
3. The host reaches assistant-message creation after its preceding asynchronous work.
4. An implementation that treats the first assistant message as a new execution would now clear the
   mark. That violates the requirement that a mark applied during an execution survives later
   notifications from that same execution.

Clearing on the earlier user message would instead misclassify `noReply` requests. Combining those
signals with an arbitrary time window or a session-wide exception does not establish causality. The
sidebar therefore keeps busy, retry, questions, and permissions visible while preserving the manual
mark. It does not manufacture execution sequences from these observations.

## What would close the gate

A future integration must establish a confirmed start identity and order through a supported public
host capability, including recovery after missed events. A separately registered workflow must
associate its actual execution with its operation ID and the exact mark revision that caused it. The
implementation must persist and reconcile that evidence before enabling host-driven policies.

Runtime acceptance must cover at least:

- `noReply` creates history without reopening a marked session.
- A mark applied during running work survives repeated busy, retry, and later assistant/tool steps.
- A genuinely new user execution clears the mark once under the automatic policy.
- A correlated report exception preserves only its own mark; concurrent user work still reopens it.
- Reconnect, restart, delayed events, and delayed report results cannot overwrite newer decisions.
- Explicit shell and command work has a documented policy and verified execution boundary.

Tests of the pure policy engine do not replace these host scenarios. Providing this capability
report makes the current limit explicit; it does not satisfy the automatic-policy release gate.

## Primary sources

- [Public TUI event bus](https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/plugin/src/tui.ts)
- [SDK messages, request options, status, and events](https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/sdk/js/src/v2/gen/types.gen.ts)
- [Prompt, run loop, shell, and subtask execution](https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/session/prompt.ts)
- [Host status implementation](https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/session/status.ts)

See also [the agreed completion specification](specification.md#completion-mark) and
[the adapter validation limits](v1-adapter-validation.md).
