# Quiet transport-health fallback

**Implemented; CPU checks pass, but stable resource acceptance remains blocked by hosted delayed
RSS: +80.6641 MiB against the unchanged +64 MiB limit.** No failed run was rerun to green.

The global health request now waits **60 seconds after activation or a healthy response**, instead
of five seconds. A known outage retries **15 seconds after settlement**; the request deadline stays
at **two seconds**. This reduces nominal healthy request frequency twelvefold. Native events still
update Active, Later, Pinned and Other sessions immediately. No per-session polling, session cap or
feature restriction was added.

The owner explicitly prioritized idle performance over rapid detection of a silent disconnect. HTTP
failure detection can now take about 62 seconds plus scheduling delays. After a settled failure,
probe-driven recovery can take about 17 seconds; native events may recover sooner. A successful
probe restores the quiet interval. An independently broken event stream with working HTTP remains
outside this fallback's detection capability.

There is still at most one pending request. Scope replacement and disposal cancel the timer and
pending request; timed-out responses cannot restore certainty. If the host ignores abort, another
request waits for settlement rather than accumulating. Fulfilled response bodies are not aborted.
See the [contract](performance.md#bounded-tui-transport-health-fallback) and the preceding
[health-path diagnostic](health-crossover-diagnostic.md), which motivated the change but does not
measure this new cadence.

## Exact candidate and validation protocol

Runtime `dist/tui.js` SHA-256: `4ba1671d7074735ebb604f41be2b8a3ef2064db5d51c4b19c6a1a52f96899b57`.

Formatting, both type checks, architectural boundaries, build and **233 tests / 26,462 assertions**
passed before native measurement. Timer tests cover first request, steady health, failed responses,
timeout, recovery to the quiet interval, noncooperative cancellation and disposal. The adapter's
double-cut regression retains native recovery between failed health probes.

The local campaign was declared before measurement, with one execution of each scenario in this
order, no retry-to-green and unchanged **+64 MiB RSS / +1 CPU point** resource budgets:

| Scenario                   |          Sessions |  Pairs | Settle / observation per process | Purpose                                      |
| -------------------------- | ----------------: | -----: | -------------------------------- | -------------------------------------------- |
| Original short gate        |           25, 250 | 3 each | 2s / 5s                          | Original startup-sensitive resource gate     |
| Original delayed gate      |               250 |      3 | 20s / 10s                        | Original separate delayed resource gate      |
| Sustained observation      |               250 |      1 | 20s / 210s                       | Includes at least three real health requests |
| Native attach cut/recovery | Synthetic fixture |      — | Bounded real proxy cut           | OpenCode 1.19.3 transport compatibility      |

Resource scenarios use stock OpenCode 1.18.30 and Bun 1.3.14. Short and delayed windows generally
finish before the first request; passing them cannot establish health-path cost. The added sustained
driver forwards the original public SDK method and records bounded timestamps in memory, writing
only after measurement. It requires three successful calls inside the sampled window, checks the
60-second spacing and product hash, and applies the original resource limits as an additional
reference check. It does not replace the repeated original gates or prove repeatability.

Run the sustained driver with a **fresh output directory**:

```sh
OPENCODE_BIN=/absolute/path/to/opencode-1.18.30 \
SIDEBAR_SUSTAINED_DIR=/absolute/path/to/fresh-evidence \
bun scripts/benchmark-sidebar-sustained.ts
```

Hosted native validation replaces the old 30-second diagnostic with this longer observation, while
retaining both original resource gates. Transport probes allow the newly documented detection
latency and the native event client's existing reconnect backoff; event-response budgets stay
unchanged. CPU and RSS limits were not relaxed.

## Local resource results

All original local resource gates and the sustained reference check passed on the exact runtime
above. Each row is sidebar minus baseline; the original gates use the median of three pairs.

| Scenario                          | RSS difference | CPU difference | Outcome                |
| --------------------------------- | -------------: | -------------: | ---------------------- |
| Short, 25 sessions                |    +9.1016 MiB | +0.2003 points | Passed                 |
| Short, 250 sessions               |   +40.7422 MiB | -0.2001 points | Passed                 |
| Delayed, 250 sessions             |    +6.1563 MiB | +0.0998 points | Passed                 |
| Sustained, 250 sessions, one pair |    -0.7031 MiB | +0.2282 points | Reference check passed |

The sustained sidebar completed **three real health calls** during 210.58 seconds of sampling. Their
durations were 1.35–1.69 ms and their start-to-start intervals were 60,006–60,007 ms. The sidebar
rendered **zero additional frames** from readiness through measurement completion. Aggregate TUI CPU
was 2.1368% without the sidebar and 2.3649% with it; endpoint RSS was 604.95 and 604.25 MiB
respectively. These are whole-process measurements, not attribution of all CPU to the health method.
The brief request durations do not include later runtime/GC work.

Memory fell during both sustained observations, especially the enabled process (659.10 to 604.25
MiB). Startup and collection effects remain visible. The delayed individual CPU deltas were +0.0998,
+1.9998 and -1.9001 points: a passing median is not a claim that every pair or machine stays below
one point. No failed resource run was discarded or retried in this campaign.

The stock OpenCode **1.19.3** attach trial passed all **11 checks**, including a real 70-second
transport cut, unknown activity, preserved mark/pin/Later, missed rename/create/delete
reconciliation, fresh native events and client restart. Recovery including native event-stream
reopening took 20.95 seconds after restoring the proxy. This is controlled loopback evidence, not an
SSH/WAN or combined-harness trial.

## Hosted results and remaining blocker

The exact code commit is `694868192447a93e3411f3666da344921948732c`. The subsequent report changes
documentation only.
[CI](https://github.com/aalvarez-labs/opencode-sessions-sidebar/actions/runs/42410511268) passes on
Ubuntu/macOS/Windows, including package verification, and the
[isolated container](https://github.com/aalvarez-labs/opencode-sessions-sidebar/actions/runs/42410511226)
passes. In the
[terminal workflow](https://github.com/aalvarez-labs/opencode-sessions-sidebar/actions/runs/42410511222),
Ubuntu and macOS graphical jobs pass. Ubuntu reports 18 sidebar checks, 107.0 ms input-observation
p95, seven approved-design checks and eleven native cut/recovery checks. This is automated
geometry/color and native input evidence; no new manual pixel-review claim is made.

The native resource job fails its final required gate because delayed RSS exceeds its budget:

| Scenario                          |   RSS difference | CPU difference | Outcome                |
| --------------------------------- | ---------------: | -------------: | ---------------------- |
| Short, 25 sessions                |     -45.5273 MiB | -6.9995 points | Passed                 |
| Short, 250 sessions               |     -25.6094 MiB | -3.8043 points | Passed                 |
| Sustained, 250 sessions, one pair |     +20.6172 MiB | +0.0901 points | Reference check passed |
| Delayed, 250 sessions             | **+80.6641 MiB** | -0.9997 points | **RSS failed**         |

The hosted sustained observation includes three real successful calls, spaced at least 60 seconds
apart, using the same product hash. Large negative short-window differences are startup-sensitive
whole-process measurements, not a claim that the sidebar accelerates stock OpenCode.

The three delayed RSS differences are **+102.2969, +13.9727 and +80.6641 MiB**. Both outlying pairs
are retained. Every delayed sample ends less than 34 seconds after TUI spawn, before the first
60-second product health request. Extending that interval further therefore cannot eliminate these
observed pre-probe differences.

In pair 1 the baseline's RSS falls from 845.25 to 700.82 MiB during sampling while the enabled
process stays near 803.11 MiB. In pair 3 the approximately 80.66 MiB difference is already present
at the beginning and both processes remain nearly flat. All enabled delayed observations have zero
additional frames and the same five mounted row containers. These receipts establish the failed
budget and substantial process-memory variation; they do not identify allocation ownership, prove a
leak or justify dismissing the failure as host noise.

The next performance investigation must attribute startup/resident-memory differences. No session
cap, feature restriction, forced GC, longer acceptance settle, relaxed budget or retry-to-green has
been applied. The PR remains a draft; stable V1 and combined-harness integration are not approved.
See the [machine-readable campaign summary](validation/quiet-transport-health.json). Historical
failures remain evidence for their own runtimes.
