# Rendered-sidebar process resource comparison

This harness compares stock OpenCode with and without the actual built sidebar. It supplements the
headless adapter comparison and focused input/render smoke; it does not replace either. The package
remains an experimental development build. The recorded run below applies only to its stated
workload and source digests.

## Predeclared workload and budgets

Use Linux process counters, Bun 1.3.14, official OpenCode 1.18.30 and a 140-by-40 `xterm-256color`
POSIX pseudo-terminal. Seed 25 and then 250 synthetic idle sessions through the public SDK. Each
treatment receives a fresh copy of the same host data, a separate cache and empty plugin
organization state, with the same first session selected. Operating-system caches remain warm and
are not flushed. No prompts, external models, credentials, optional metadata providers or extensions
are enabled. The sidebar uses balanced density and ASCII icons.

Run three paired repetitions per dataset, alternating baseline/enabled order. Both treatments load
the same observer; only the enabled treatment loads the complete built sidebar. The observer
verifies the selected route, visible sidebar geometry and rendered frame text before marking a
treatment ready. After two seconds of stabilization, the parent samples process CPU/RSS over five
seconds. During this interval the observer performs no polling or SDK reads. It watches a precreated
completion-receipt file, and the parent appends its signal only after sampling. Lifecycle checks run
after that acknowledgement. Completed samples are checkpointed before those later checks, so an
incomplete lifecycle run cannot erase the measurements that preceded it.

These budgets are fixed before the first measurement of this harness:

| Measurement                              | Budget for each dataset                                                                                                     |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Median paired end-of-window RSS increase | At most 64 MiB                                                                                                              |
| Median paired CPU increase               | At most 1.0 percentage point of one CPU core                                                                                |
| Enabled rendering                        | Selected session's sidebar controls visible inside the viewport; header and completion action in the captured render buffer |
| Lifecycle                                | Two deactivate/reactivate cycles restore visible controls; final deactivation removes them                                  |

The 64 MiB allowance applies to the full rendered plugin, including its normalized model, local
organization service and UI. It is distinct from the headless adapter's 32 MiB budget. The idle CPU
allowance remains one percentage point. Existing navigation (250 ms p95) and component-burst (500
ms) budgets are unchanged. Do not widen budgets after observing a failed run.

Startup-to-ready and repeated reactivation times are descriptive measurements, not accepted latency
thresholds. Three samples do not establish a stable tail latency.

## Run and retain evidence

Build first, then run the benchmark by itself, with no concurrent build or other native probes:

```sh
bun run build
OPENCODE_BIN=/absolute/path/to/opencode \
  SIDEBAR_RESOURCE_REPORT=/absolute/path/to/rendered-resources.json \
  bun run scripts/benchmark-sidebar-runtime.ts
```

The optional `SIDEBAR_PLUGIN_FILE` selects an external built TUI artifact. Its digest is recorded as
`runtimePlugin`; source hashes still identify this checkout's harness and source, not the external
package's origin. The default loads `dist/tui.js` from this checkout. No font installation or
terminal configuration change is performed.

The report records all 12 treatments, paired deltas, versions, hardware, budgets, source/artifact
SHA-256 hashes, visible-frame checks and lifecycle outcomes. All source hashes are checked again at
completion. Failures write a partial report when a report path is supplied and then exit nonzero; a
partial report is never a successful acceptance receipt. The parent directory must already exist.
Temporary synthetic host data and processes are cleaned up, with a six-minute watchdog.

### Thread attribution diagnostic

`SIDEBAR_RESOURCE_DIAGNOSTIC=true` retains the separate thirty-second, one-pair diagnostic at 250
sessions. Each one-second trace point now includes a bounded Linux `/proc/<pid>/task` snapshot: up
to 128 threads, at most eight concurrent reads, thread names and user/system CPU tick totals. The
helper is included in source hashes. No thread enumeration runs in either acceptance mode.

Interval attribution matches both TID and start time, so a reused TID is not mistaken for the same
thread. Newly observed, missing, unreadable, truncated and regressed counters remain explicit.
Snapshots are non-atomic and slightly offset from aggregate process samples; a thread that starts
and exits between snapshots can be missed entirely. Matched thread CPU is therefore partial
attribution, never an alternative process total or a passing resource receipt. Reading these files
also adds diagnostic overhead in the parent process. This mode does not evaluate acceptance.

The diagnostic trace additionally parses `RssAnon`, `RssFile`, `RssShmem` and `VmSwap` from the
`/proc/<pid>/status` content already read for each process sample. This adds no filesystem reads and
does not change sample cadence. Kernel `kB` counts are recorded as KiB and converted to MiB; zero is
a measured value, while missing, malformed or duplicate fields explicitly remain unavailable. No
memory-breakdown parsing runs in either acceptance mode. The pure parser is included in source
hashes. These counters distinguish anonymous, file-backed and shared resident memory; swap is
separate from RSS. They do not identify a JavaScript object, native allocation or worker as the
owner, and their sum need not match the separately sampled aggregate RSS exactly. No heap snapshot,
forced garbage collection, extra stabilization interval or budget change is introduced by this
diagnostic.

## Scope and remaining limits

### Additional delayed-start gate

The correction campaign `42285547308` passed the short comparison, but its diagnostic still ended
with a +131.58 MiB RSS difference at 250 sessions. CPU and RSS in the first five seconds were
dominated by host startup work. That short pass therefore does not establish stable idle overhead.

Before the next campaign, add an independent, stricter acceptance requirement:
`SIDEBAR_RESOURCE_DELAYED=true` uses 250 sessions, three alternating baseline/enabled pairs, a fixed
20-second settling interval and a 10-second observation. The existing 64 MiB RSS / 1.0 CPU point
median-delta limits are unchanged. The original short gate and separate 30-second diagnostic still
run and retain their results; this additional gate does not replace or relabel them. The longer
fixed delay is not itself proof of steady state.

Both treatments now wait for the selected session's native title and Context/0-token frame before
publishing readiness. A ready route alone could precede native rendering (the old baseline at 250
sessions reported only 32 initial renderables). The report records this common visible-frame
condition, then checks it again after measurement. No added observer polling or SDK calls occur
during sampling.

RSS and aggregate-thread CPU describe the TUI process, not the whole machine or child processes.
Main-thread context switches are recorded only as context; they are not timer/wakeup counts. The
observer's public lifecycle checks establish control removal and restoration, not the absence of
every retained allocation or subscription. No private host storage is edited.

This short idle workload does not establish sustained-load CPU/memory, input latency, native font
rendering, browser/remote transport behavior, power-loss recovery or cross-platform runtime
compatibility. Idle sessions also do not exercise busy-row animation or attention visibility under
load. Keep the existing correctness/input/attention probes and broader release gates separate.

## November 7 development merge

[PR #8](https://github.com/aalvarez-labs/opencode-sessions-sidebar/pull/8) integrated the reviewed
design into `main` at the owner's explicit request. This is not resource acceptance or a package
release. The tested product head was `508024130543d9650effdddbb4d774e5147e884b`, with TUI SHA-256
`a0a2c756b93ef1facff84b165d8db6046ef0b07e006e4e718befbe4e86438b3a`. The merge commit is
`84d11919cc81811298b298ea161ea16a58c6fe62`.

The
[hosted campaign](https://github.com/aalvarez-labs/opencode-sessions-sidebar/actions/runs/42323803252)
passed both graphical jobs and native transport checks. Its resource job failed the original short
CPU gate. Keep that failure alongside the successful CI and container jobs:

| Comparison            | Median added RSS | Median added CPU | Result                           |
| --------------------- | ---------------: | ---------------: | -------------------------------- |
| Short, 25 sessions    |       9.0078 MiB |   -8.5927 points | Passed                           |
| Short, 250 sessions   |       3.5781 MiB |    1.2050 points | **Failed CPU**                   |
| Delayed, 250 sessions |      16.2891 MiB |    0.9999 points | Passed, no meaningful CPU margin |

All three short 250-session CPU deltas exceeded the fixed 1.0-point budget: 1.2050, 4.5966 and
1.2000. With 100 clock ticks per second, these represent 60, 230 and 60 ms of added process CPU in
the roughly five-second windows. The delayed pass does not cancel them. No budget, repetition count
or observation window was changed in response.

Every enabled 250-session receipt reported zero render-loop increments between readiness and the
measurement receipt. Viewport scans and animation therefore cannot explain ongoing rendering cost in
those windows. The measurement still includes all TUI process threads and host startup work; it does
not by itself attribute CPU to sidebar JavaScript. Thread-level diagnostic evidence is needed before
changing the health fallback or rendering semantics to address this failure.

## November 7 legibility follow-up

The
[PR #9 campaign](https://github.com/aalvarez-labs/opencode-sessions-sidebar/actions/runs/42359267055)
tested `b4eca4629ba3a48b3be7c29f2424cf967f2351ac`, TUI SHA-256
`c192771e64a01d8a117e47e323e660950129522e93d341327867e23cada33a97`. Both graphical jobs passed,
including the seven shared approved-design checks. The resource job failed its original short CPU
gate; the PR remained draft. GitHub's test-merge checkout had the same source tree as this head.

| Comparison            | Median added RSS | Median added CPU | Result         |
| --------------------- | ---------------: | ---------------: | -------------- |
| Short, 25 sessions    |      -7.3945 MiB |   -4.3990 points | Passed         |
| Short, 250 sessions   |      -0.4922 MiB |    1.2124 points | **Failed CPU** |
| Delayed, 250 sessions |      46.9023 MiB |   -0.4995 points | Passed         |

Short 250-session CPU pair deltas were +1.2124, +4.5984 and -4.9993 points. The corresponding RSS
deltas were -62.0313, +86.3281 and -0.4922 MiB; delayed RSS pairs were +100.1250, +46.9023 and
+26.2852 MiB. This variability prevents interpreting the negative medians as a stable saving. Every
enabled 250-session measurement recorded zero additional render-loop frames. The delayed pass does
not cancel the short failure, and the earlier `852b140` short RSS failure remains relevant.

The separate thirty-second diagnostic ended at +185.383 MiB process RSS: anonymous residency
differed by +185.602 MiB, file-backed residency by +0.063 MiB, with no shared RSS or swap. The
non-atomic counters do not identify allocation ownership. Renderable/text-buffer counts remained
stable; exposed heap counters cannot account for all host worker or native allocations. Further
function-level diagnosis must distinguish the TUI JavaScript VM from the host's worker VM and keep
profiled measurements separate from acceptance. No forced GC or changed limits are justified by
these receipts.

## Fulfilled-health cleanup investigation

The subsequent `2df3d85` hosted campaign passed the original short and delayed gates, but did not
establish repeatability: its delayed RSS pairs were +203.3594, +25.6133 and -23.4805 MiB. The same
product bundle had previously failed delayed RSS at a median +89.9648 MiB. A separate local
prepared-dependency diagnostic still measured +1.1995 CPU points at 250 sessions. These results
remain separate from acceptance of any later product change.

Reanalysis of retained traces found CPU spikes near the five-second health cadence. A bounded
follow-up compared the complete original sidebar with a candidate that skips only the final abort of
an already fulfilled health request. Both retained real health requests, five-second scheduling,
two-second deadlines, cancellation of pending requests, full rendering and lifecycle checks. It used
250 sessions, real pinned dependencies prepared equally for both arms, two seconds of settling,
thirty seconds of observation and three alternating original/candidate pairs. The observer was
unchanged; identical wrappers recorded bounded health timing and existing event callbacks in memory,
writing only after measurement. No stock baseline, forced GC or acceptance evaluation was used.

| Pair | Candidate minus original CPU | Final ten seconds CPU | Endpoint RSS difference |
| ---- | ---------------------------: | --------------------: | ----------------------: |
| 1    |               -0.3308 points |        -0.2984 points |            +19.0156 MiB |
| 2    |               -0.0347 points |        +0.0870 points |             -3.2188 MiB |
| 3    |               -0.6309 points |        -0.4998 points |             +8.9766 MiB |

All six treatments passed native visibility, scrolling and lifecycle checks, with six successful
real health calls, zero delivered events on the product's subscriptions and zero additional rendered
frames during each window. The whole-window CPU median difference was -0.3308 points, but pair two
was approximately one Linux CPU tick and its final-ten-second difference changed sign. Periodic
spikes persisted in both arms. This is modest, variable diagnostic evidence, not proof that residual
CPU or RSS limits are resolved. Recorded wrapper signals describe the state before the monitor's
`finally` block and cannot be used to count subsequent aborts.

The cleanup is retained as a narrow candidate with correctness coverage. Original short and delayed
resource gates remain unchanged and must be evaluated independently on its exact bundle before
resource acceptance. No visual changes or reduced session coverage are part of this investigation.

The exact candidate bundle `313b09c024de2bfb8bc0f054e9d4f9d3e729ecf19c34120ea7251fd68928e29e` then
ran each original gate once, without prepared dependencies, wrappers or changed sampling:

| Gate                  | Median added RSS | Median added CPU | Result         |
| --------------------- | ---------------: | ---------------: | -------------- |
| Short, 25 sessions    |     -31.9648 MiB |   +0.7999 points | Passed         |
| Short, 250 sessions   |     +20.5195 MiB |   +0.7996 points | Passed         |
| Delayed, 250 sessions |     +48.8555 MiB |   +1.4001 points | **Failed CPU** |

Delayed CPU pairs were +0.8000, +1.4001 and +1.4998 points. The short pass does not cancel that
failure. All 18 treatment lifecycle checks passed. Separately, the same bundle passed all eleven
native remote-transport checks, including real loss detection, automatic recovery, fresh events and
annotation persistence. The full local check passed 222 tests and 1,480 assertions. These results
support correctness of the cleanup, but **resource acceptance remains open**.

A second, separate diagnostic tested removing project/workspace context only from the global health
request through public per-call SDK options. A contract check preserved authentication, custom
fetch, other headers, shared-client defaults and cancellation. The same six-treatment protocol then
found candidate-minus-original CPU deltas of -0.0635, -1.1935 and +1.0649 points; the
final-ten-second median was +0.0009 points, effectively zero at this counter resolution. The two
large opposing differences coincided with increased `HeapHelper` CPU and falling RSS in opposite
arms. This does not establish allocation ownership or consistent savings. The header candidate was
discarded; it is not part of the product change. Allocation ownership and repeatable resource
acceptance remain unresolved.

### Native instruction profiling follow-up

A separate diagnostic change at `37704fa` completed one instrumented baseline/enabled pair on an
isolated Ubuntu runner, measuring the previously published `2df3d85` / `09ffee5a...` product rather
than the local cleanup candidate. It retained the original observer, 250 synthetic sessions, equally
prepared real dependencies, two-second settling and thirty-second process windows. Both native and
lifecycle checks passed. This is diagnostic evidence only, not an original acceptance campaign.

The initial attempt at `3d2a115` captured only the baseline and failed during symbol processing. Its
raw capture and failure remain preserved. Offline analysis exposed both expensive inline/source
expansion and incorrect symbol translation when the full profile ELF substituted for the runtime:
matching Build ID and native text did not imply matching executable file offsets. The correction
uses the unchanged runtime with conventional separate debug information, disables inline expansion
and bounds the complete ordinary analysis process group. No measurement window, budget or product
behavior changed to obtain the completed diagnostic.

The corrected capture contained 156 baseline and 214 enabled samples. Independent address/range
audits verified all 156 baseline native leaves and 211 enabled native leaves; three enabled JIT
addresses remain unresolved. All samples belonged to the expected TUI and fell inside measurement,
with no reported lost events. Marking, visitation and GC finalization dominated both profiles. Every
recorded call chain had one frame, so these results identify sampled native instructions, not
callers, allocation ownership or the cause of the additional work.

Instrumented CPU was 3.1257% baseline versus 4.1261% enabled, with a +37.09 MiB endpoint RSS
difference. The enabled sidebar produced zero additional frames from readiness through measurement,
while roughly five-second CPU spikes persisted. The profiler itself reported about 2.7 million
wakeups per treatment, making disturbance an explicit limitation. Neither this single pair nor its
native symbol audit overrides the cleanup candidate's failed delayed CPU gate above. Resource
acceptance and release readiness remain open; no further product workaround is justified by these
leaf samples alone.

## Recorded November 6 comparison

This is an earlier development result, not approval of every later revision. The subsequent
[isolated terminal campaign](isolated-terminal-validation.md) found the 250-session RSS budget
failing on hosted runners. Keep both results with their exact source hashes; a previous passing
receipt does not override a later failure. Current PR evidence records the follow-up fixes and their
new measurements.

The [complete receipt](validation/sidebar-rendered-resources.json) passed all 12 treatments with the
predeclared budgets unchanged. Both datasets used three pairs, official OpenCode 1.18.30, Bun 1.3.14
and the built sidebar on Linux. Exact hardware, versions, source/runtime hashes and all individual
measurements are in the receipt. The working tree was based on `16ffcf0`; its recorded digests
identify the new measured content.

| Dataset           | Median paired RSS increase | Median paired CPU increase | Budgets            |
| ----------------- | -------------------------: | -------------------------: | ------------------ |
| 25 idle sessions  |                  17.81 MiB |   0.0003 percentage points | 64 MiB / 1.0 point |
| 250 idle sessions |                  56.63 MiB |   0.3987 percentage points | 64 MiB / 1.0 point |

Every enabled treatment rendered the selected session's controls, completed two public
deactivation/reactivation cycles, and removed the controls on final deactivation. These lifecycle
visibility checks do not establish zero retained heap or long-running memory stability. The
250-session RSS result leaves limited room below this development budget; it does not establish a
supported maximum session count.

The [first incomplete attempt](validation/sidebar-rendered-resources-incomplete.json) stopped before
measuring the 250-session dataset because the observer's list request used the SDK's default
100-record limit. The observer now explicitly requests the expected dataset size; the product
adapter already supplied its own bounded limit. The entire paired comparison was rerun without
changing the workload, product, observation windows or acceptance budgets. The incomplete receipt is
retained as a failed harness run, not acceptance evidence.
