# Quiet transport-health fallback

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

Native measurements and hosted validation are in progress. Earlier failures remain historical
evidence, and this change is not yet stable V1 approval or combined-harness integration.
