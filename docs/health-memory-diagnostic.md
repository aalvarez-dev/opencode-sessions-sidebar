# Health transport memory diagnostic

This isolated GitHub Actions experiment investigates resident-memory differences without changing
the sidebar product or relaxing its resource budgets. It is diagnostic evidence, not acceptance
validation, a transport regression test, or a performance fix.

The Ubuntu 24.04 workflow pins Bun 1.3.14, OpenCode 1.18.30 and action revisions. It uses synthetic
sessions and disposable configuration, without prompts, model inference, credentials or user
devices. Its pull-request trigger includes only this document and the two dedicated diagnostic
files; manual dispatch is also available. It does not change the existing validation workflow.

## Controlled difference

Both variants import the identical built `dist/tui.js` through an external wrapper. The wrapper
forwards the public API to the current host objects and intercepts only `client.global.health`:

- **Real:** invokes the original SDK method with its original receiver and arguments.
- **Stub:** returns a healthy response without executing the health SDK/RPC request.

Both keep the real product monitor, five-second schedule, timeout controllers, disposal, session SDK
calls, state, rendering and sidebar features. Neither mutates the host API. Empty proxy targets
avoid invariants caused by frozen host properties; forwarded getters retain their original receiver.

Each health call records elapsed time and success in a bounded in-memory array, identically in both
variants. No telemetry file is written during the measured window. A receipt is appended only when
the host disposes the activation after the existing observer's `lifecycle-started` marker exists.
The initial activation must report successful health calls for a diagnostic pair to be valid. A
response arriving after its abort deadline is not counted as successful, even if its body says
healthy. These call timings cover the initial activation, including the brief scroll check after
sampling; they are not a count restricted to the measured window. The rendered tree must also remain
unchanged between the initial and final snapshots.

## Predeclared sequence and outputs

Three rounds run sequentially: real/stub, stub/real, then real/stub. Every variant invokes the
existing resource harness in diagnostic mode, with one independent stock baseline and enabled
process, 250 sessions, two seconds of settling and a 30-second trace. There are six diagnostic pairs
in total. The original reports are retained unchanged. Product and wrapper SHA-256 hashes accompany
every pair.

`summary.json` reports the median of each variant's three paired endpoint RSS deltas and the median
of its paired CPU deltas over the final ten seconds of each trace. CPU intervals crossing the window
boundary are weighted by overlap. The summary is complete only when all six pairs, lifecycle checks
and health receipts are valid. Failed reports, logs, generated wrappers and partial summaries remain
available in the workflow artifact.

The driver accepts `--prepare-only` to generate wrappers for inspection without starting OpenCode.
That mode deliberately leaves the summary incomplete and supplies no experimental results.

The experiment always reports `acceptanceEvaluated: false`. A successful workflow means the
diagnostic completed; it does not mean the product satisfies the unchanged 64 MiB RSS or one-point
CPU budgets. The stub cannot establish working disconnect detection. Different baseline processes
and shared runner conditions still introduce variance. A fixed final-ten-second window does not
prove steady state, and RSS alone cannot distinguish native buffers, worker heaps, JIT memory or
allocator retention.

Run this experiment once to test the health-transport hypothesis. A consistent contrast can justify
a focused follow-up; it does not justify selecting favorable runs or removing health functionality.
