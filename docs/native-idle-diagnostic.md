# Isolated native idle profiling

This diagnostic investigates native CPU activity that JavaScript-only profiles cannot explain. It
changes no sidebar product behavior and does not evaluate resource acceptance. The package remains
an experimental development build. A completed profile is evidence for investigation, not a passing
release gate or a demonstrated optimization.

## Fixed target and workload

The workflow builds a separate checkout of the already published development commit
`2df3d858d1491749288bb92f330230b5b6d327f3` and requires its TUI SHA-256 to be
`09ffee5a091ce92c470ca52f3f799be6d5d88d6e79110ee9e189430d0046eaed`. The diagnostic PR does not
publish later local product experiments. Bun 1.3.14, the official Linux x64 baseline OpenCode
1.18.30 binary, and its exact public SDK are pinned independently of the diagnostic source.

One stock-baseline treatment is followed by one enabled-sidebar treatment, each with 250 synthetic
idle sessions in the original 140-by-40 pseudo-terminal. Both receive the same real, preinstalled
`@opencode-ai/plugin@1.18.30` dependency closure and npm lock. This removes background dependency
installation as a confound, but changes the original fresh-config acceptance workload. Both retain
the exact original resource observer, selected native frame checks and full viewport/lifecycle
checks. No prompts, inference, user accounts, private session data or user machines are involved.

After native readiness, the parent attaches a disabled profiler to the synthetic TUI it just
spawned. The process PID, effective/real UID, executable digest and process start time must match
the expected owned target. A different PID namespace is a blocker, not permission to remount, change
namespaces or bypass a profiler check. The two-second settling period follows profiler attachment.
Thirty seconds of process CPU/RSS and bounded per-thread counters then run with native profiling
enabled. No forced GC, extra health requests, product polling or changed acceptance limits are
introduced.

## Capture scope and synchronization

The fixed event is userspace `cpu-clock:u` at 199 Hz, with DWARF call chains and a 16 KiB sampled
stack. This software event avoids requiring a hardware PMU. `--pid` selects the owned TUI's existing
threads, including its worker and heap helpers. `--no-inherit` deliberately excludes subsequently
created threads and subprocesses. Initial/final thread inventories and sampled TIDs make this
coverage limit explicit. No system-wide or kernel capture is requested.

The profiler starts with `--delay=-1`. Private FIFO commands use a single outstanding request and
bounded acknowledgement deadlines: `ping`, `enable`, `disable`, then `stop`. Linux perf's
terminating NUL after `ack\n` is handled across read boundaries. Buffered replies are read before an
exited profiler is treated as a failure. A stop acknowledgement is not proof of a flushed data file:
the parent separately requires process exit code zero and actual nonempty samples.

`--clockid=mono` and parent `clock_gettime(CLOCK_MONOTONIC)` timestamps provide comparable clocks.
Enable send/acknowledgement brackets precede process sampling; sample start/end markers precede the
disable send/acknowledgement brackets. All command receipts and boundaries are retained. The
profiler is stopped and flushed before the observer receives its measurement-complete signal, so
viewport scrolling and deactivate/reactivate checks cannot enter the native idle profile.

## Declared runner privileges and cleanup

Capture mode is fixed before the campaign. The hosted workflow declares an owned disposable runner
administrator mode: `sudo -n timeout ... perf record` targets only the synthetic TUI PID. This is
not an escalation attempted after a denied capture. Current-user mode remains available when
explicitly selected before starting. If the declared mode cannot attach, acknowledge commands,
record samples or read the resulting data, the diagnostic fails and retains its blocker.

Neither mode changes `perf_event_paranoid`, kernel settings, capabilities, mounts, namespaces or
repository settings. The only additional privileged operation makes the known regular `perf.data`
file readable for analysis. Capture has a fixed 120-second timeout, with an interrupt and a
five-second final kill bound. The resource harness also retains its six-minute watchdog, and the
driver/job have outer bounds. Cleanup targets only owned child processes and temporary FIFO handles.

## Exact native symbols

The workflow downloads the official Bun 1.3.14 baseline profile archive as symbol data. The Python
preflight verifies its fixed archive digest, safe extraction, exact build ID and executable `.text`
address, size and digest against the installed OpenCode binary. It never executes the profile binary
or replaces stock OpenCode. The symbol file stays outside the uploaded artifact and is stored
without executable permission.

The parent repeats file identity checks using incremental hashing, avoiding large transient buffers
near the measured TUI. Recording uses `--no-buildid-cache`; only after capture does the diagnostic
populate a separate cache with the verified matching symbols. That cache also stays outside the
uploaded evidence. Analysis retains full native call chains, reports grouped by thread and symbol,
the observed build IDs, unresolved frames and lost-event records. It requires actual samples from
the expected TUI PID. JIT/generated code and some call chains can remain unresolved even when native
build IDs match; no symbol name is fabricated to fill those gaps.

## Outputs and preparation

`summary.json` always has `acceptanceEvaluated: false`. It distinguishes preparation, completion and
blocked/incomplete capture. `resources.json` retains the original process comparison and native
checks. Each treatment retains `perf.data`, control receipts, full profiler stderr, sample text,
call-chain text, symbol reports, native readiness and lifecycle receipts. The generated harness, its
exact diff from the pinned target, dependency inventory, SDK lock and source/runtime hashes make the
changes reviewable. Failed terminal/readiness receipts remain available where produced. Dependency
trees, native databases and the large symbol cache are not uploaded as evidence.

The driver consumes explicit prepared paths: `SIDEBAR_NATIVE_TARGET_REPO`,
`SIDEBAR_NATIVE_DEPENDENCIES`, `OPENCODE_BIN`, `PERF_BIN`, `SIDEBAR_NATIVE_SYMBOL_FILE`,
`SIDEBAR_NATIVE_SYMBOL_REPORT`, `SIDEBAR_NATIVE_PERF_CACHE` and `SIDEBAR_NATIVE_OUTPUT`.
`SIDEBAR_NATIVE_PERF_SUDO=true` selects the declared runner administrator mode. Run
`bun .github/diagnostics/native-idle.ts --prepare-only` to verify inputs and generate inspectable
sources without starting OpenCode or perf. Preparation never reports a completed native experiment.
The FIFO framing tests can be run separately with
`bun test ./.github/diagnostics/native-perf.test.ts`.

This single instrumented pair cannot establish a stable overhead distribution, sustained-load
behavior, allocation ownership or release acceptance. The unchanged short and delayed resource gates
remain independent. A native profile is useful only to select a concrete, testable follow-up; it is
not permission to repeat measurements until a preferred result appears.
