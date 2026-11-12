# Activation-attribution criteria (pre-registered)

Pre-registered before the first run; mirrors `scripts/lib/attribution-criteria.ts`.

## Campaign shape

- 10 pairs total; the first 2 are discarded as warm-up, leaving at least 5 evaluable pairs.
- A single pre-declared extension to 16 pairs is allowed when the first verdict is INCONCLUSIVE.
- 250 synthetic idle sessions, first session selected, seeded once and copied per arm.
- Arms run sequentially and interleave order each pair; only import/activate differ between arms.
- Same K host events are injected into both arms; the product's reaction is the measured cost.
- No forced GC and no `app.heap_snapshot` inside the measured window.

## Measured windows

- Total: first import + first activation + idle, the engineering budget applies here.
- Import: within the started process, before-import to after-import.
- Activation: over the post-import module graph, after-import to after-activate.
- Events: ready to after-events.
- Idle: after-events to ready+idle, sampled at 1 Hz.

## Budgets and statistics

- Budgets unchanged: median RSS delta at most 64 MiB and median CPU delta at most 1.0 point.
- 30 s stabilization before the first sample; 70 s idle so an idle full GC can plateau.
- FAIL only when the median exceeds its budget AND the signal exceeds 3×IQR of the same samples.
- Over-budget but noisy, or spread larger than the budget, is INCONCLUSIVE, never PASS.
- Fewer than 5 evaluable pairs is INCONCLUSIVE, never PASS.
- PASS requires both RSS and CPU within budget with spread no larger than the budget.

## Interpretation

- Deltas are within-process (post minus pre in the same process) to cancel host startup variance.
- The verdict is data; it never accepts V1 and the pull request stays draft.
