# Isolated Codespaces lab

This lab runs the experimental sidebar in the **OpenCode terminal TUI** inside a GitHub Codespace.
Use the browser's integrated terminal from the Mac; no local OpenCode, Bun, Docker, fonts, or SSH
tools are required. It does not use OpenCode's web interface.

The development container installs **Bun 1.3.14** and **OpenCode 1.18.30**, then installs this
checkout's dependencies with the frozen lockfile and builds the local TUI entrypoint. These are the
existing tested versions, not a compatibility claim for newer releases or OpenCode V2. The package
remains a private development build.

The configuration and commands are preparation for a Codespaces trial. They do not establish a
successful Codespaces provisioning or browser-terminal test. That manual validation remains pending;
the existing [stock-host receipts](sidebar-validation.md) describe their own environments.

## Create the Codespace

1. Open this repository on GitHub and select **Code → Codespaces → New with options**.
2. Select branch **`review/sidebar-stability-20261004`**, which contains the PR #7 fixes and this
   lab configuration. Until that PR is merged, `main` does not contain the complete trial.
3. Select the repository's development container and a **2-core / 8 GB** machine. Choose a region
   near you and create the Codespace.
4. Open it in the browser and wait for the container setup and post-create build to finish. If setup
   fails, inspect the creation log before running the commands below.
5. Open **Terminal → New Terminal** in the browser editor, in the repository checkout.

Creating the Codespace requires your GitHub account and consumes its Codespaces allowance. Review
the account's usage and budget before creation. No application ports need to be forwarded or made
public for this terminal-only trial; the development container disables automatic port forwarding.

## Verify the checkout

Run:

```sh
bun run lab:verify
```

This runs the complete repository check and both existing stock-OpenCode sidebar smoke probes. The
first exercises rendered input, navigation, organization, and persistence. The second exercises
native attention events using a deterministic provider on the container's loopback interface.
Neither requires a paid model account or external model inference. The probes have their own
temporary isolated state and do not populate the interactive lab with their fixtures.

Reports are written under the ignored **`.sidebar-lab/reports/`** directory. Keep any failure output
with the report; a partial report or a locally passing run is not evidence that the entire
Codespaces check passed. The smoke budgets are unchanged, so a resource-constrained Codespace may
expose a failure that needs investigation.

The same run saves `sidebar-frames.json` and `attention-frames.json` alongside the reports. These
contain actual renderer cells, colors, and layout captured from stock OpenCode during the synthetic
probes. The GitHub Actions workflow retains these files and the reports in the
`codespaces-lab-receipts` artifact for seven days. An authorized GitHub connector can download that
artifact for review without signing in to GitHub in a browser.

These files are rendered-cell evidence. Any replay or PNG reconstructed from them is not a
screenshot of the Codespaces browser and does not provide live terminal control. Browser fonts,
keyboard transport, and the manual interaction checklist still require their own validation.

## Open the interactive lab

Run:

```sh
bun run lab:start
```

The launcher starts stock OpenCode in a synthetic Git project using a dedicated profile. The project
has its own `lab` branch and a small README, separate from this source checkout. Its configuration,
native session data, cache, and sidebar annotation storage live inside the ignored `.sidebar-lab/`
directory. The launcher passes a small environment allowlist instead of inheriting provider
credentials or personal OpenCode settings. Project configuration, default plugins, model catalog
fetching, and automatic updates are disabled for the trial. Only the local sidebar build is loaded,
with ASCII icons and balanced density. External providers are disabled with `enabled_providers: []`.

This isolates the OpenCode trial's configuration and state; it does not turn the entire Codespace
into a credential-free environment or a separate security sandbox. The lab is for synthetic session
organization, not real model conversations. Do not add provider credentials for this first check.

OpenCode may initially open **Connect a provider**. Press **Esc** to close that dialog; this trial
does not need a provider. The native sidebar appears after opening a session:

1. Click **new session +** on the home screen, enter a synthetic title, and press **Enter**.
2. Create two or three synthetic sessions with **new session +** in the sidebar. No prompt or model
   call is necessary. Close the stock **Getting started** card if it covers part of the sidebar.
3. Use **Sessions sidebar: browse** in the command palette to open an existing session or its
   actions. Browse is also the fallback on the home screen and in narrow terminals.

Make the terminal wide enough to display the native sidebar, ideally around **140 columns**. Keep
keyboard focus in the terminal when using OpenCode shortcuts. ASCII icons avoid requiring a Nerd
Font on the Mac.

## Manual acceptance check

- The active session has **no row ellipsis** and retains its direct Mark/Unmark completed action
  below its expanded content. The global header menu remains available.
- A non-active session retains its ellipsis. After switching sessions, the old active row regains
  its menu and the new active row loses its menu. Browse still exposes all active-session actions.
- Mark and unmark a session. The mark changes without changing the selected session, pin state, or
  Later membership.
- Pin a session, add it to Later, and navigate to another session. Later remains a manual list;
  opening an entry does not submit a prompt or remove the entry.
- Expand and collapse context independently of the R/B/W selection. Repository and Worktree should
  both refer to the synthetic profile's project directory; Branch should show `lab`.
- Exit OpenCode using its native quit action, run `bun run lab:start` again, and reopen the same
  session through Browse. Confirm pins, Later order, and completion marks survive.
- Narrow the terminal until the native sidebar disappears, then use Browse to reach the same
  sessions and actions. Widen it again and check mouse and keyboard navigation.

The automated attention probe covers additional busy/retry/permission/question/error scenarios. An
idle manual session is not evidence that those states render correctly. Browser-terminal results
also do not certify Ghostty, native macOS font rendering, or every terminal shortcut.

## Start clean and finish

Exit the current OpenCode process, then run:

```sh
bun run lab:fresh
bun run lab:start
```

The first command selects a new empty profile; the second launches it. Previous profile directories
are preserved, so this does not delete sessions or reclaim their storage. Subsequent `lab:start`
runs resume the new current profile. Do not run `lab:fresh` while another lab TUI is still open.

A container rebuild does **not** clear `/workspaces`, including this checkout's `.sidebar-lab/`
directory. Use `lab:fresh` for a fresh app profile. To remove the whole disposable environment and
recover its storage, delete the Codespace after saving any reports or source changes you need.

Stop the Codespace from GitHub's Codespaces list when pausing the trial; simply closing the browser
tab is not a reliable immediate stop. A stopped Codespace still uses storage. Delete it when the
trial is finished if you do not need to retain that workspace.

When reporting results, include the checkout commit (`git rev-parse HEAD`), command outcome,
browser, terminal size, and the relevant JSON reports. Explicitly distinguish a completed automated
check from the manual browser checklist.

## References

- [GitHub: creating a Codespace for a repository](https://docs.github.com/en/codespaces/developing-in-a-codespace/creating-a-codespace-for-a-repository)
- [GitHub: rebuilding a container and retained workspace data](https://docs.github.com/en/codespaces/developing-in-a-codespace/rebuilding-the-container-in-a-codespace)
- [GitHub: Codespaces billing](https://docs.github.com/en/billing/concepts/product-billing/github-codespaces)
- [Sidebar setup, behavior, and runtime evidence](sidebar-validation.md)
