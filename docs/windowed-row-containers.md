# Windowed row containers: optimization and remaining blocker

Follow-up: [function counters and a mirrored health crossover](health-crossover-diagnostic.md) now
support a contribution from the real health request path. The product, original limits and failed
acceptance outcome below remain unchanged; a detection-latency decision is pending.

**Experimental optimization; resource acceptance still fails. Do not promote to stable V1 or
interpret this change as approval for combined-harness deployment.**

Runtime `dist/tui.js` SHA-256:

```text
a97cf2d85d921dd4915ea5429f470c235e9b92ab3668603e5fa72895691b2949
```

## Change and scope

The earlier renderer mounted nearby row contents but retained a native container for every top-level
session. Groups now use prefix heights, two spacers and a binary search to mount only nearby row
containers. The full session model, scroll extent, attention summaries and actions remain available.
Prefix heights rebuild when rows or their heights change; viewport lookup is logarithmic in group
size. No per-row polling or extra timer was introduced.

The active row retains its existing visibility handling. Expanded descendant shells retain their
existing strategy; this does not claim to virtualize every nested container. Health cadence,
deadlines, transport recovery and resource budgets are unchanged. There is no session cap.

All six enabled 250-session measurements retained **5 row containers and 331 renderables**, with
zero additional frames during the measured window. The preceding same-size fixture retained 250
containers and 573 renderables: 98% fewer row containers and about 42% fewer total renderables. This
is a structural comparison, not evidence of proportional process-memory or CPU savings. Native
checks reached the final session, preserved the full scroll extent and returned to the top.

The initial implementation applied visibility twice and temporarily left a newly mounted group
without its child-disclosure control. The native attention test failed. Grouped rows now mount their
contents directly inside the already-windowed container; the unchanged test subsequently passed.
That failed attempt is retained in the evidence summary.

## Resource results

One campaign was declared before measurement: baseline/baseline short and delayed controls, followed
by candidate short and delayed comparisons. No retries, forced GC, profiling, reduced coverage or
widened limits. Stock OpenCode 1.18.30 and Bun 1.3.14 ran in a disposable Linux x64 environment.
Each result is the median of three alternating pairs. Original windows remain 2 seconds settling / 5
seconds observation and 20 seconds / 10 seconds respectively.

| Candidate gate        | Added RSS median |   Added CPU median | Result     |
| --------------------- | ---------------: | -----------------: | ---------- |
| Short, 25 sessions    |     +18.3164 MiB |     +0.3999 points | Passed     |
| Short, 250 sessions   |      +3.7148 MiB | **+2.9990 points** | **Failed** |
| Delayed, 250 sessions |      +8.0117 MiB |     +0.4995 points | Passed     |

Limits remain **+64 MiB / +1.0 CPU point**. The three short 250-session CPU differences were
+1.5967, +2.9990 and +3.3995 points; none passed. Delayed differences were +0.9002, -0.3995 and
+0.4995 points. A delayed pass cannot replace the short failure or earlier failed acceptance.

Both control arms loaded only the baseline observer, without importing the sidebar. Their median
differences were +0.9766 MiB / +0.0008 CPU points at 25 sessions, +48.5195 MiB / +0.5997 points at
250 sessions, and +3.7617 MiB / +0.1000 points in the delayed window. One delayed control pair
varied by +3.9000 CPU points. These controls demonstrate process variation, not an allowance to
subtract noise from the candidate or disregard its failure. The environment is shared, not dedicated
benchmark hardware.

The benchmark sampling code is unchanged. Its post-measurement structural probe replaces the
obsolete requirement for one retained container per session with a viewport container bound, full
scroll height, last-session visibility, unchanged scroll extent and return-to-top checks. This
adapts the geometry assertion to virtualization; it does not relax resource limits.

## Validation and interpretation

An independent linear intersection oracle checks variable-height ranges. Lifecycle tests cover large
jumps, shrinking lists, clipping, hidden/detached ancestors, zero-height terminals and disposal.
Formatting, types, boundaries, build and **233 tests / 26,458 assertions** passed. Stock 1.18.30
passed 17 navigation/mutation checks and 10 native attention checks; observed input p95 was 129.21
ms against the unchanged 250 ms budget. Seven approved-design geometry/color checks also passed in
the stock renderer with deterministic synthetic public-read inputs; that visual fixture does not
validate native execution. Local frames are real PTY observations, not real pixel screenshots or
macOS certification.

A separate fresh offline package installation on Linux x64 OpenCode 1.19.3 passed 17 sidebar and 10
attention checks (input p95 95.71 ms); 11 remote attach/recovery checks also passed. Product
source/runtime hashes match this optimization. The tested archive predates this documentation
update, so its checksum identifies that test archive only. This is not combined-harness validation.

See [the machine-readable receipts](validation/windowed-row-containers.json) for all pairs,
structural observations, source hashes, native compatibility results and the failed initial attempt.
The control generator changed only its checkout location, disabled plugin loading and the enabled
probe flag in both arms, and labelled its final report as a non-acceptance negative control. Its
generated-source hash is recorded separately from the original benchmark source hash.

The smaller render tree is a verified improvement. Residual short-window CPU remains unresolved;
zero extra frames do not prove which worker, allocation or background task owns that CPU. There is
no demonstrated basis for choosing a session limit, disabling alerts or changing health cadence.
Keep the optimization reviewable and unmerged while this blocker remains open. Any proposed
functional restriction needs its own measured benefit and an explicit product decision.

The [candidate-1 handoff](v1-integration-candidate.md) describes the preceding frozen product and
its hashes. It is historical evidence, not installation instructions for this new runtime.
