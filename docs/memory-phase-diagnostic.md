# Native memory attribution

This diagnostic investigates the unresolved RSS acceptance failure. It does not change the product,
the original acceptance harness, the 64 MiB RSS budget, the one-point CPU budget, or session
coverage. It always reports `acceptanceEvaluated: false`. A green diagnostic means the experiment
completed.

## Protocol

Use Linux, Bun 1.3.14, stock OpenCode 1.18.30 (or explicitly 1.19.3), the unchanged built TUI, 250
synthetic sessions, a 140 x 40 terminal, ASCII icons and balanced density. Each process receives an
independent copy of the same seed database and disposable configuration, cache and organization
storage. No inference, credentials, user configuration or self-hosted runners are involved.

`scripts/diagnose-memory-phases.ts` runs **control / import / data / full / full / data / import /
control**, once each, sequentially. The control loads only the diagnostic wrapper; import loads the
product without activating it; data activates the actual product but suppresses public slot
registration; full forwards the public host API unchanged except for bounded observations. All SDK
requests and events are real. Suppressing UI is an ablation, never an acceptable product mode.

Checkpoints cover import, activation, native session readiness, then 20 and 45 seconds of
observation. Readiness requires the selected native session's title, Context and token display;
data/full also require all five startup SDK calls to complete. Records contain Linux RSS/private/PSS
fields, the embedded Bun version, `bun:jsc` heap statistics, allocator statistics, frame count, live
subscription count and pending requests. Main-context heap counters do not cover every worker or
native allocation. The counters themselves perturb timing and allocation; they are not CPU
acceptance measurements. Neither phase experiment explicitly invokes garbage collection.

Data/full must dispose all observed subscriptions and pending requests. Full also waits ten seconds,
reactivates through the public plugin API, waits another ten seconds, then disposes again. These
bounded lifecycle checks do not prove absence of every possible leak.

`scripts/diagnose-memory-heaps.ts` runs separate **full / control** processes. At the same 45-second
endpoint it saves `/proc/self/smaps` and invokes the host's public `app.heap_snapshot` command,
which writes both TUI and internal server-worker snapshots. **Heap capture can collect garbage and
itself increase RSS by over 1 GiB.** Post-capture RSS must never be used for product acceptance or
interpreted as product retention. Snapshot shallow sizes are not retained sizes or resident-page
ownership.

Set `OPENCODE_BIN` to the actual executable and `SIDEBAR_MEMORY_DIR` to a fresh output directory.
For 1.19.3 also set `SIDEBAR_TEST_OPENCODE_VERSION=1.19.3`. Existing summaries are never overwritten
on startup; there are no retries. Generated wrappers, raw observations and terminal logs are
retained. Current reports hash both the product and host executable. Local exploratory runs used the
x64 baseline binary; the hosted npm installer may select the optimized binary. Version labels alone
do not establish binary equivalence.

## Local evidence, unchanged product

Product SHA-256: `4ba1671d7074735ebb604f41be2b8a3ef2064db5d51c4b19c6a1a52f96899b57`. The phase
campaign used OpenCode 1.18.30 with embedded Bun 1.3.14.

| Mode            | First endpoint RSS (MiB) | Reverse endpoint RSS (MiB) |
| --------------- | -----------------------: | -------------------------: |
| Control         |                   609.96 |                     625.13 |
| Import only     |                   654.85 |                     605.77 |
| Data without UI |                   656.98 |                     654.80 |
| Full sidebar    |                   614.65 |                     657.80 |

All eight cases completed. Full has five rendered session row containers; deactivation leaves zero
observed subscriptions and requests. Import-only varies by approximately 49 MiB without running any
product controller or rendering. These results do not identify a consistently dominant component.

Separate forensic pairs, with full before control in each version:

| Host    | Pre-capture full minus control RSS | TUI snapshot shallow delta | Server snapshot shallow delta |
| ------- | ---------------------------------: | -------------------------: | ----------------------------: |
| 1.18.30 |                         +24.05 MiB |                  +1.67 MiB |                     +0.43 MiB |
| 1.19.3  |                          +4.96 MiB |                  +2.07 MiB |                     +0.14 MiB |

These are single diagnostic pairs, not comparative version acceptance. The snapshots do not explain
the earlier hosted +199.70 MiB RSS failure and do not justify a speculative product change or a host
upgrade claim. Original hosted failures remain blocking: delayed median +80.66 MiB in one campaign,
sustained +199.70 MiB in another. The next experiment runs the same attribution protocol on a GitHub
hosted runner, preserving every result. No user device or private server is required.
