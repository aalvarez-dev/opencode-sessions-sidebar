# Activation attribution campaign — results (2026-11-11)

Status: verdict computed. This is **not** an acceptance receipt. The PR stays draft and V1
acceptance is the owner's decision.

## Method

Workflow: `.github/workflows/isolated-activation-attribution.yml`, run `43104116136` on `da6e86a`,
`workflow_dispatch` with `run_campaign=true` (GitHub-hosted `ubuntu-24.04`, free for the public repo
— no quota consumed).

- **10 interleaved sequential pairs.** Even pair: product then control. Odd pair: control then
  product. Arms run one after the other, never concurrently (concurrent arms would contaminate the
  shared CPU counters).
- **First 2 pairs discarded as warmup** (JIT and one-time host warmup); the remaining **8 are
  evaluable**. All 10 pairs completed, so no pair was lost to a crash.
- Each arm is a freshly started host process that seeds **250 synthetic sessions** and performs the
  same 5 startup SDK calls and subscriptions. The **product** arm imports and activates the sidebar;
  the **control** arm never imports the product. Both arms receive the **same 20 injected
  `session.create` events**, so the emission cost cancels and only the product's reaction remains.
- The only asymmetry between arms is the product import / activation / deactivation.

Windows (within one process, `post − pre`, then paired DiD `product − control`):

| window     | from → to                     | purpose                           |
| ---------- | ----------------------------- | --------------------------------- |
| import     | before-import → after-import  | module graph residency            |
| activation | after-import → after-activate | controller/SDK/subscription setup |
| events     | ready → after-events          | reaction to 20 identical events   |
| idle       | after-events → ready+idle     | sustained 70 s observation        |
| **total**  | before-import → ready+idle    | composite (~74 s) for the verdict |

Metrics: `rssMiB` (`process.memoryUsage().rss`) and `cpuPoints` (process `usrcpu+syscpu` seconds ÷
elapsed × 100). Both are whole-process deltas, which cancel the large host startup baseline.
Criteria are pre-registered in `activation-attribution-criteria.md` and shared with the analyzer
through `scripts/lib/attribution-criteria.ts`.

## Verdict

`verdict=FAIL_CPU rss_median=18.7910 cpu_median=2.0681 evaluable=8`

| metric       | median (paired DiD) |   IQR | budget | verdict                            |
| ------------ | ------------------: | ----: | -----: | ---------------------------------- |
| RSS (MiB)    |              +18.79 | 65.65 |  64.00 | under budget (inconclusive spread) |
| CPU (points) |               +2.07 |  0.52 |   1.00 | **over budget**                    |

RSS is now **under budget** as a median and no pair is a clear RSS failure. CPU is **over budget**
and above the 3×IQR signal threshold — a real effect, not noise.

## Per-window attribution (median / IQR)

| window     | RSS med | RSS IQR | CPU med | CPU IQR |
| ---------- | ------: | ------: | ------: | ------: |
| total      |  +18.79 |   65.65 |   +2.07 |    0.52 |
| import     |   +1.30 |   15.84 |   +4.16 |   39.90 |
| activation |   −0.42 |    8.40 |  +10.30 |   27.39 |
| events     |  −42.65 |   81.81 |   +7.47 |    1.79 |
| idle       |  +40.55 |  149.79 |   +2.82 |    4.58 |

Absolute CPU-seconds (median, 8 evaluable pairs), product vs control:

| window      |    elapsed |    Δ CPU-s |                       rate |
| ----------- | ---------: | ---------: | -------------------------: |
| import      |      0.1 s |     +0.047 |                         ~0 |
| activation  |       ~0 s |     +0.027 |                         ~0 |
| events (20) |      3.6 s |     −0.741 |     load shifted to server |
| **idle**    | **70.0 s** | **+1.912** | **+2.73 %/core sustained** |
| total       |     74.4 s |     +1.456 |                    +1.96 % |

## Findings

1. **The RSS blocker is a measurement artifact.** With within-process deltas over 10 pairs, the
   product's real footprint is import `+1.3 MiB`, activation `~0`, total median `+18.79 MiB` — all
   far below the `64 MiB` budget. The historical failures (`+80.66` delayed, `+199.70` sustained,
   `100.35 MiB` spread between two controls) came from cross-process startup variance and allocator
   purging: in the existing phase diagnostic the `+45 s` idle delta was actually _negative_
   (`−67.77 MiB` for product, `−34.55 MiB` for control).
2. **The CPU blocker is real and sustained.** The extra CPU is concentrated in the **idle** window
   (`+1.91 CPU-s` over 70 s ≈ `+2.73 %` of one core at 250 sessions), not in a one-time import or
   activation burst (both `≪0.05 CPU-s`). The product genuinely does more work rendering the
   250-session sidebar in steady state than a host without it.

## What this means for acceptance

- The RSS part of the budget is satisfied by the product within this method.
- The CPU part is a genuine sustained idle cost above the `1.0`-point budget. Closing it requires
  either a product performance investigation of the idle render path (where the CPU is spent)
  followed by an optimization, or an explicit owner decision to revisit the CPU budget. Neither is
  applied here.

## Reproduce

```bash
gh workflow run isolated-activation-attribution.yml \
  --ref perf/idle-render-20261107 -f run_campaign=true
# after it finishes:
gh run download <run-id> --dir /tmp/aa
bun run scripts/analyze-activation-attribution.ts /tmp/aa/summary.json /tmp/verdict.json
```

The analyzer recomputes the same verdict printed above; its output is data, not an acceptance
receipt.
