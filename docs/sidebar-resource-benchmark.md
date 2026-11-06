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

## Scope and remaining limits

RSS and aggregate-thread CPU describe the TUI process, not the whole machine or child processes.
Main-thread context switches are recorded only as context; they are not timer/wakeup counts. The
observer's public lifecycle checks establish control removal and restoration, not the absence of
every retained allocation or subscription. No private host storage is edited.

This short idle workload does not establish sustained-load CPU/memory, input latency, native font
rendering, browser/remote transport behavior, power-loss recovery or cross-platform runtime
compatibility. Idle sessions also do not exercise busy-row animation or attention visibility under
load. Keep the existing correctness/input/attention probes and broader release gates separate.

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
