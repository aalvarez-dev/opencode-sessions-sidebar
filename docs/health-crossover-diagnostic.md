# Idle CPU: function counters and within-process health crossover

**Diagnostic complete; no product restriction or performance-gate change applied.** The evidence
supports a CPU contribution from the real health request path. It does not identify individual
allocations, prove a host defect or close stable V1 resource acceptance.

The product remains `1f1ceda6d63b519705da610388188613b487ab0a`, runtime SHA-256
`a97cf2d85d921dd4915ea5429f470c235e9b92ab3668603e5fa72895691b2949`. Only a disposable diagnostic
copy was instrumented. Its different runtime SHA-256 is
`36adad87c5304c46eef6bb21e5cd169c6e694ac27416aad9e5a306166e6ad1e9`.

## Function-entry observation

Zero extra frames did not establish whether hidden models recomputed or events executed. A
TypeScript AST inventory inserted bounded entry counters at all 578 function bodies in the product
source, including getters and inline callbacks. Counters were enabled around readiness through
measurement acknowledgement and written after sampling. They do not separately count async
continuations or attribute native/runtime allocations. Host-provided Solid/OpenTUI imports remain
external; this instrumented copy is not a release artifact.

In the first 32-second sidebar observation, **36 entries occurred at five transport-health sites**:
six probe invocations and their scheduling/cancellation helpers. No other instrumented product
function was entered. There were zero additional frames. The baseline arm had zero counter entries.
This narrowed the next experiment to real health requests rather than more UI changes.

## Mirrored crossover

Two fresh stock OpenCode 1.18.30 processes each loaded the same complete instrumented sidebar with
250 sessions, using Bun 1.3.14. Each process contained four 30-second phases:

- **A:** invoke the original public SDK health method with its original receiver and arguments.
- **B:** return a synthetic healthy response in the diagnostic wrapper. The monitor, five-second
  cadence, deadline controllers and lifecycle remain active.

The predeclared sequences were **A-B-B-A**, then **B-A-A-B**. This compares health modes within each
process and reverses their placement in time. It reduces independent-process/startup noise; it does
not eliminate time effects or carryover. No retry or acceptance budget was evaluated.

CPU came from the original parent process/thread observer at one-second intervals. Analysis used
only intervals wholly contained between one second after each phase began and one second before it
ended. Measured parent/child clock offsets were 32.31 ms and 28.31 ms. Each retained phase contained
more than 26 seconds of observations. All eight full phases recorded six successful calls; phase
guards affect CPU interval selection, not that full-phase call count.

| Sequence |    Real-request CPU | Synthetic-response CPU | Real minus synthetic |
| -------- | ------------------: | ---------------------: | -------------------: |
| A-B-B-A  | 5.3554% of one core |                3.8767% |   **+1.4786 points** |
| B-A-A-B  | 2.9531% of one core |                2.0464% |   **+0.9068 points** |

Each process recorded **144 entries**, again exclusively at the five health-monitor sites, and zero
additional frames. Each real-request phase was higher than both synthetic phases in its process.
Thread counters show contributions from the main thread, worker and `HeapHelper` threads; thread
names are not an allocation profile or proof of a leak.

See [the machine-readable summary](validation/health-crossover-diagnostic.json) for every phase,
function counts, thread ticks, timings, protocols and original-receipt hashes.

## API constraint and stopping point

The pinned public plugin API exposes the SDK and typed event bus, but no transport-loss callback.
The local worker fetch path forwards requests through RPC and buffers response text; an additional
SSE stream is not a compatible substitute on that transport. The global health handler itself is
small; these measurements cover the whole SDK/RPC/server/runtime path, not just that handler.

Pinned upstream sources:

- [TUI SDK integration](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/tui/src/context/sdk.tsx)
- [Worker request/response forwarding](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/cli/tui/worker.ts)
- [RPC transport](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/util/rpc.ts)
- [Global health and event handlers](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts)

There is now measured support for the health path's contribution. There is still no demonstrated
equivalent lower-cost public mechanism to promote safely. Limiting session coverage would not remove
this periodic path. Skipping health or returning synthetic success would lose real disconnect
detection and must never become the product fix.

The next concrete product option would be to **experiment with a ten-second health interval while
retaining the two-second timeout**. That changes the nominal worst-case detection interval from
about seven to twelve seconds, excluding scheduler delays. A longer interval is only a hypothesis
for reducing CPU; it has not been tested or applied, and no passing budget is promised. It needs an
explicit product decision before implementation. Keeping the present detection contract means
retaining the five-second interval and investigating the host path further.

The product and original budgets remain unchanged. Do not merge or declare stable V1 based on this
diagnostic, or treat synthetic phases as functional transport validation.

## Completed hosted regression for the unchanged product

[CI](https://github.com/aalvarez-labs/opencode-sessions-sidebar/actions/runs/42405726321),
[container](https://github.com/aalvarez-labs/opencode-sessions-sidebar/actions/runs/42405726373) and
[native terminal validation](https://github.com/aalvarez-labs/opencode-sessions-sidebar/actions/runs/42405726318)
all passed, including Ubuntu/macOS graphical scenarios. Hosted short 250-session medians were
+46.8359 MiB / -4.1944 CPU points; delayed medians were +8.9688 MiB / -0.2999 points. One delayed
RSS pair was +199.1172 MiB. These passing medians do not supersede the earlier local short
250-session CPU failure of +2.9990 points or establish repeatable resource acceptance.
