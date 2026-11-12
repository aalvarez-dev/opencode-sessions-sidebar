# Steady-state idle CPU attribution

This run answers the open question from the third native campaign: the only acceptance gate that
failed there was the **short-gate CPU** (+1.1992 points at 250 sessions), while the delayed-gate CPU
and the sustained CPU windows passed. The earlier activation attribution reported a sustained idle
CPU of about +2.07 points, but that window was contaminated: it injected 20 `session.create` events
and then measured the idle tail, so the CPU of the event burst and its follow-on rebuild/collection
leaked into the "idle" number.

This diagnostic measures idle CPU **without any event burst**, so the 20-event rebuild and its
garbage collection cannot be mistaken for a sustained cost.

## Method

- `scripts/diagnose-activation-attribution.ts`, N=10 interleaved pairs; each pair runs the product
  arm and the control arm sequentially in their own host process.
- Symmetric arms: both register the same subject and observer plugins; the **only** asymmetry is
  that the control arm never imports or activates the product. Control CPU therefore pays the same
  host overhead.
- 250 synthetic sessions, balanced density, `ascii` icons, no events
  (`SIDEBAR_ATTRIBUTION_EVENTS=0`), `forcedGC=false`.
- Steady window: 30 s settle after the native session is ready, then 70 s idle. The measured window
  is `settled → ready+idle`.
- CPU is the whole-process `process.cpuUsage()` delta (microseconds), so host startup is cancelled
  algebraically by the within-process delta and the paired difference.
- Warm-up: the first 2 pairs are discarded; the 5-pair floor and acceptance arithmetic come from the
  pre-registered `docs/validation/idle-steady-state-criteria.md`.

## Steady-state result (8 evaluable pairs)

| Metric                   | Median DiD |   IQR | Budget | Verdict      |
| ------------------------ | ---------: | ----: | -----: | ------------ |
| CPU (points of one core) | **+0.136** | 0.142 |    1.0 | **PASS**     |
| RSS (MiB)                |      −0.84 | 141.9 |     64 | INCONCLUSIVE |

CPU is inside the budget and its paired spread is small. RSS is centred on zero but its
within-process spread (IQR ≈ 142 MiB) is larger than the 64 MiB budget, so RSS stays INCONCLUSIVE
for this window — the resident set keeps drifting by hundreds of MiB inside a single process
regardless of the product, which is the same native-allocator noise the phase diagnostic already
documented. It is not evidence of a product regression (median below zero).

## Where the CPU actually goes

CPU as a percentage of one core, median across the 10 arms of each side:

| Segment                                        | Control | Product |      DiD |
| ---------------------------------------------- | ------: | ------: | -------: |
| mount (`after-activate → ready`, first render) |  259.0% |  264.7% | +5.7 pts |
| settle (`ready → +30 s`)                       |   21.6% |   21.5% | −0.1 pts |
| idle (`+30 s → +70 s`)                         |    1.8% |    1.8% | −0.0 pts |

The expensive segment is the host's own first render of the 250-session native view (`mount`), which
burns roughly 2.6 cores **in both arms**. That cost decays to about 21% over the first 30 s and to
about 1.8% in steady idle, in both arms. After `ready` the sidebar's incremental CPU is
indistinguishable from zero.

The cold window (N=2, 0 s settle, 5 s observe — a cold probe that drops the 2 s settle of the short
acceptance gate; the deviation from the pre-registered 2 s settle is recorded in the criteria doc)
confirms the
front-loading: the first 5 s after `ready` burn 54–112% of a core in both arms, with the product
only somewhat higher in one pair (112% vs 54%) and level in the other (65% vs 60%). With two pairs
this is not enough to attribute a number, but it shows the cost is a transient of the first seconds,
not a sustained one.

## Profiles

CPU profiles were captured through `node:inspector` (`Profiler.start/stop`, Bun 1.3.14 exposes it
inside the host) and, after the closing snapshot was moved out of the capture window, no longer
contain the observer's own `heapStats()` walks. The 5 s cold windows are still too short and too
noisy — hashed chunk URLs, profiler start/stop boundary time — to attribute frames reliably, so the
profiles are not used for the verdict above. The CPU-time measurement is authoritative for the PASS.

### Precision caveat

The `+0.136` median is a tight upper bound on the sidebar's incremental cost, not an exact figure:
both arms take an `after-events` snapshot even with zero events, and that snapshot's `heapStats()`
walk runs inside the measured window. Because the product arm carries the mounted sidebar, its walk
can be marginally larger; at ~100 ms this is ≈0.14 points — comparable to the median, far below the
`1.0` budget, and of an uncertain sign. The PASS holds by a wide margin. Removing this harness
overhead (skip the empty `after-events` snapshot, or read `cpuUsec` before the walks) is a
refinement for a future window, not a correction to this result.

## Interpretation

- The **sustained** idle CPU cost of the sidebar at 250 sessions is within budget (PASS). The
  earlier +2.07 figure was the 20-event burst, not a steady cost.
- The short-gate failure (+1.1992) is a **front-loaded transient** of the first seconds after
  `ready`, dominated by the host's own mount of the native 250-session view. It decays to noise
  within the settle window.
- Whether the short gate (2 s settle + 5 s observe) should gate a sustained budget, versus a product
  change to shrink the first-seconds transient, is a separate decision. It is not taken here and V1
  is not declared accepted.

## Reproduce

- Steady measurement: `workflow_dispatch` of `isolated-activation-attribution.yml` with
  `run_idle_diagnostic=true` (job `idle-diagnostic`). Artifact `idle-diagnostic`, retained 14 days,
  includes `docs/validation/idle-steady-state.json` and the per-arm JSON.
- Profiles only: the same workflow with `run_idle_diagnostic=true` and `profile_only=true`.
- Verdict:
  `bun scripts/analyze-idle-steady-state.ts <summary.json> docs/validation/idle-steady-state.json`.
