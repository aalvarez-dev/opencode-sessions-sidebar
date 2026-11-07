# Pinned stability campaign

This diagnostic-only change measures candidate `4f5f1ba3cd5ac4facef0e93cd9668f6aaf32d417`, whose
built TUI SHA-256 is `a91d70019f34307548355234859f80130bac1cc8483adee6bdcc9535bf1a472d`. It does not
change product code or promote this candidate. The target is checked out independently of this
diagnostic branch and its generated harness. Never substitute another revision mid-run.

## Predeclared campaign

Three separate Ubuntu runners execute the original, unmodified acceptance scripts. Each runs:

- Short: 25 and 250 sessions, three alternating baseline/enabled pairs, 2 s settle / 5 s
  observation.
- Delayed: 250 sessions, three alternating pairs, 20 s settle / 10 s observation.
- Original median limits: added CPU at most 1 point and RSS at most 64 MiB.

Every campaign must pass both gates. A failing short gate does not suppress the delayed report;
fail-fast is disabled across runners. There is no retry, fourth compensating campaign, profiler,
prepared dependency substitution, changed window or changed budget. Retain all individual pairs, not
just medians. This is a new predeclared campaign; prior passing runs are not retroactively counted
toward it. Hosted runners remain shared hardware, not a deterministic laboratory.

## Separate long observation

A separate runner observes one stock baseline and one enabled candidate for 20 minutes each, after a
fixed 20-second settle per treatment, with 250 synthetic sessions. Light parent-process reads of CPU
ticks, RSS and memory categories occur at minute checkpoints. Checkpoints stay in bounded parent
memory and are written after measurement or through the existing failure path. No in-host polling,
profiler, heap snapshot or forced GC is introduced. The original observer's completion deadline is
extended to 25 minutes and the parent watchdog to 50 minutes. The product, health deadlines and
health cadence remain unchanged.

This single ordered pair is not another acceptance campaign or proof of a memory leak. Its report
must be inspected for startup effects, drift and interval behavior; it cannot establish allocation
ownership or quantify every native memory category. A green observation job means the protocol and
native visibility/lifecycle checks finished, not that retention is certified.

## Separate 50-cycle observation

The actual candidate is activated, deactivated/reactivated 50 times, and finally deactivated. Each
cycle waits 5.5 seconds while active so the real health monitor can run, then 7.5 seconds while
inactive, exceeding its 5-second schedule plus 2-second deadline. Passive diagnostic wrappers count
public event subscriptions, pending health calls, calls started after disposal, and events delivered
after disposal. They preserve the current host client, receivers, authentication, request arguments
and cancellation signals. These wrappers are never used in the resource gates or long observation.
Each inactive checkpoint must have zero tracked live subscriptions/pending health calls and no
post-disposal calls/events. Counts, memory and renderer statistics are retained after every cycle,
including failures. Initial activation plus 50 reactivations produces 51 disposal checkpoints
including final cleanup.

There is no global timer census: quiet inactive intervals establish absence of observed health
requests, not absence of every closure/task. Existing non-cooperative/late-response unit coverage
and real remote cut/recovery checks remain separate. RSS and heap snapshots are not used to invent a
zero-leak threshold. Memory trend and bounded ownership require review after completion.

## Reproduction and scope

Use Bun 1.3.14 and stock OpenCode 1.18.30. Set `SIDEBAR_CANDIDATE_ROOT`, `OPENCODE_BIN` and a fresh
`SIDEBAR_STABILITY_OUTPUT`, then run `.github/diagnostics/stability-campaign.ts long-idle` or
`cycles`. `--prepare-only` verifies pins and source anchors and writes generated files without
launching a host. `--smoke` is local preflight only (three-second observation / two cycles),
explicitly labelled and rejected inside Actions. It cannot count as a full campaign. Source
replacements require exactly one matching anchor, failing closed if the pinned harness changes.
Generated sources and hashes are retained with all receipts. A fresh output directory is required;
nothing is overwritten to hide an earlier attempt. No user account, personal server, inference
provider or browser login is needed. Nothing merges automatically.

## Preparation evidence

Before publication, a local disposable Linux environment exercised the generated long observer with
two stock TUI treatments and four checkpoints per treatment, and the lifecycle observer with two
complete cycles plus final disposal. Both explicitly labelled smoke reports completed without an
acceptance claim. The stricter lifecycle preflight also verified monotonically increasing activation
counts and at least one health call during each active interval. Final counters were three
activations/disposals, zero live public event subscriptions, zero pending health requests, and zero
observed post-disposal calls/events. The first attempted long-smoke invocation omitted the required
host executable environment variable and exited before launching a host; its corrected invocation
used a fresh output directory. No full observation was retried or passed by shortening it.

The diagnostic branch's full check passed 202 tests / 1,348 assertions, with types, formatting,
architecture boundaries and build. The new driver also passed an explicit strict TypeScript check
because `.github/diagnostics` is outside the ordinary project typecheck. Workflow matrices and
read-only permissions were checked. These preparation results do not claim the three campaigns,
20-minute intervals or 50 cycles have completed; Actions supplies those separate receipts.
