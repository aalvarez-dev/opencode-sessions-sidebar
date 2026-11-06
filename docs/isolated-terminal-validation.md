# Isolated terminal validation

This campaign tests the experimental sidebar on disposable **GitHub-hosted** machines. It never uses
a self-hosted runner, developer workstation, personal OpenCode profile, or model credentials. The
workflow is `.github/workflows/isolated-terminal-validation.yml`; product source comes from the
checked-out revision. A successful library check is not a graphical acceptance result.

## Scenarios and evidence

| Scenario                                                                               | Environment                                                     | Evidence                                                                                     |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Organization, native input, wide/narrow layout, icon samples                           | Ubuntu 24.04, xterm, Xvfb, pinned Iosevka Nerd Font Mono        | Real terminal-window PNGs, renderer cells, assertions, selected font hash, terminal versions |
| Marked parents, native retry/questions/permissions, live children and collapsed groups | Same graphical terminal; deterministic loopback provider        | Real terminal-window PNGs and native host assertions                                         |
| Native TUI `attach`, transport cut and recovery                                        | Separate stock server and client through a loopback fault proxy | Before/during/after renderer cells and pass/fail checks                                      |
| Full rendered sidebar resource delta                                                   | Paired stock-TUI processes, 25/250 sessions, three repetitions  | Raw CPU/RSS samples and fixed 64 MiB / 1 CPU-point median-delta budgets                      |
| macOS graphical feasibility                                                            | GitHub-hosted macOS 15 Intel, Terminal.app                      | Explicit passed/blocked/failed receipt and genuine screenshots when available                |

All host tests pin OpenCode **1.18.30** and Bun **1.3.14**. Linux screenshots capture the actual
terminal's pixels from its X window; they are not regenerated from renderer buffers. The separate
renderer captures remain useful for exact text/color/position assertions. The terminal uses a
private fontconfig file and verifies the selected font against the pinned manifest, so an inherited
font with the same family name is not sufficient.

The campaign checks the established presentation: active session first; no redundant ellipsis on the
active row; direct yellow Mark/Unmark below expanded children and context; independent green
completion and live attention; Later/Pinned/Other groups; three-line rows;
repository/branch/worktree selectors; narrow dialogs and keyboard navigation. The header's global
menu remains intentional. Screenshots must also be visually reviewed before claiming that these
examples match the accepted presentation. No assertion can establish identical pixels across every
terminal and operating system.

## Isolation and interpretation

- Profiles, caches, sessions, organization storage and fixture repositories are temporary and
  synthetic. Tests do not read personal OpenCode data or contact a paid model provider.
- Jobs use `contents: read`, no persisted checkout credentials, fixed timeouts, and artifact
  retention of fourteen days. No public interactive terminal, SSH access or deployment is created.
- The transport observer must still capture while the API is unavailable. It must not call the
  adapter's invalidation method or fabricate a disconnection event on the adapter's behalf.
- The macOS pilot never changes privacy permissions or the TCC database. An unavailable graphical
  session or denied automation/capture is **blocked**, not a passing macOS visual test. A green
  capability-pilot job alone is not graphical acceptance; read its receipt.
- Xvfb is a virtual display. Successful xterm tests demonstrate this named configuration, not
  Ghostty, GNOME Terminal, all Linux distributions or a user's SSH/network path.
- Short paired resource observations do not establish sustained-load or leak-free operation.
- Unimplemented execution-correlated automatic policies remain outside the validated feature set.
  Another test machine cannot provide missing public host execution identity.

## Running and collecting

Use the workflow on a validation PR or dispatch it explicitly. All tests run on hosted machines; the
job labels must never be replaced with `self-hosted` for this campaign. Artifacts retain both
success and failure evidence. A new revision needs its own results; do not reuse a preceding green
run to approve a changed head.

For reproducibility, retain the workflow run URL, tested commit, original artifact ZIP/digest,
reports and PNGs together. Artifact titles distinguish graphical pixels, transport/resource
measurements, and the macOS capability pilot. Final acceptance must list failed or blocked gates
alongside successful checks.

The resource observer waits for an explicit measurement-finished receipt before starting lifecycle
checks. A separately labelled `SIDEBAR_RESOURCE_DIAGNOSTIC=true` mode records thirty one-second
intervals for one baseline/enabled pair at 250 sessions. It is a stability diagnostic, not a new
acceptance window or a replacement for a failed budget result. The first hosted run exposed large
RSS changes within the short window; retain that failed receipt rather than interpreting a later
trace as a retroactive pass.

This document describes the campaign. Run-specific outcomes are recorded separately after the
workflow finishes and the screenshots have been reviewed.
