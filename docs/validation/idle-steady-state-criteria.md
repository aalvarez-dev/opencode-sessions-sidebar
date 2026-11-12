# Idle steady-state diagnostic — pre-registered criteria

This document declares, before any measured run, how the idle steady-state diagnostic is
interpreted. It is committed together with the harness and is not edited afterwards without a
separate, reviewed change.

## Purpose

The activation-attribution campaign showed the CPU cost is concentrated in the idle window, but that
window began right after twenty injected events, so it could include the garbage-collection and
first-render work those events trigger. This diagnostic isolates **sustained idle**: it measures
pure idle after an explicit settle and captures a CPU profile of the same window to say where the
cycles actually go.

## Windows and order

- **Settle** (`SIDEBAR_ATTRIBUTION_SETTLE_MS=30000`): after the sidebar is ready, wait 30 s so the
  one-time model build, first render and post-seed garbage collection finish before measuring.
- **Measure** (`SIDEBAR_ATTRIBUTION_IDLE_MS=70000`): 70 s of idle with **no injected events**, long
  enough to pass the JSC full-GC idle plateau.
- **Steady window** = `settled` → `ready+idle` (`scripts/analyze-idle-steady-state.ts`).
- **Cold-window profile** (separate run): settle 0 s, observe 5 s, to characterize the front-loaded
  transient that the acceptance short gate (2 s settle + 5 s observe) only partly captures.
  **Amendment (2026-11-12, recorded before analysis):** this document pre-registered a short profile
  with a 2 s settle; the executed campaign used a 0 s settle to expose the pure front-loading. The
  deviation is recorded here, the profiles are informational only (never used for the verdict), and
  the change is not silent.

No garbage collection is forced and `app.heap_snapshot` is never invoked.

## Sample and statistic

- N = 10 interleaved sequential pairs, first 2 discarded as warm-up, minimum 5 evaluable; below that
  the verdict is INCONCLUSIVE. Profile runs use N = 2 (frames only, no verdict).
- Metric: within-process `process.cpuUsage()` delta over the steady window, paired
  difference-in-differences (product − control), reported as median and IQR.

## Verdict

Unchanged budgets: RSS ≤ 64 MiB, CPU ≤ 1.0 point. A metric FAILS only when its median exceeds the
budget **and** exceeds `3 ×` its own IQR; over-budget but noisy is INCONCLUSIVE.

## Interpretation rule

- **Steady CPU ≤ 1.0** and the profile shows no continuously dominating `plugin`/`timer`/render-loop
  bucket (top buckets are idle or host runtime, GC only around the settle) → the short-gate CPU
  failure is a **settling transient**, not a sustained cost. The next step is a product-fix vs
  short-gate-settle decision **for the owner**; the acceptance criterion is never changed silently.
- **Steady CPU > 1.0** with signal → genuine sustained idle cost → product fix, backed by the
  profile's winning frames.
- Profile unavailable (host trimmed `node:inspector`) → record the reason; the CPU-time verdict
  still stands and the profile is reported as unavailable, never as zero.

This diagnostic is **data, not acceptance**. The PR stays draft and V1 acceptance is the owner's
decision.
