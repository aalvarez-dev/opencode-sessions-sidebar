# V1 integration candidate 1

This handoff describes the frozen `a4d3bb6` candidate. A later
[row-container optimization](windowed-row-containers.md) changes the runtime hash and still fails
short-window CPU acceptance. Do not use the hashes below for that later build.

The subsequent [quiet-health build](quiet-transport-health.md) has a different runtime identity
again and passes its local short, delayed and sustained comparisons, but fails hosted delayed RSS.
This frozen handoff does not describe that build; consult its own report before planning a new
integration trial.

**Prepared for an isolated integration trial, not approved as stable V1.** The package remains
private at `0.1.0-dev.0`; identify this candidate by its source revision and hashes, not that shared
development version string. No npm release or deployment is performed by these instructions.

## Frozen product and evidence

The product is the graph-optimized `4f5f1ba3cd5ac4facef0e93cd9668f6aaf32d417` build. Subsequent
candidate preparation changes test drivers and documentation only. Its `dist/tui.js` SHA-256 is:

```text
a91d70019f34307548355234859f80130bac1cc8483adee6bdcc9535bf1a472d
```

Use Bun **1.3.14**. Stock OpenCode **1.18.30** remains the original acceptance baseline. A separate
Linux x64 integration trial on **1.19.3** passed fresh offline package installation, 17 native
sidebar checks, 10 native attention checks, and 11 remote attach/disconnect/recovery checks.
Input-to-observed-frame p95 was **111.00 ms**, against the unchanged 250 ms budget. No external
provider or user profile was used. This does not certify a complete third-party harness, macOS on
1.19.3, or an arbitrary host version.

The first 1.19.3 attempt stopped because the test observer still asserted 1.18.30. Both test driver
and observer now share an explicit two-version allowlist; no product fix or relaxed assertion was
needed. Original resource tests still require 1.18.30. The failed attempt remains in the evidence.

The completed
[stability campaign](https://github.com/aalvarez-labs/opencode-sessions-sidebar/actions/runs/42394045854)
has a **failed acceptance outcome**:

| Campaign | Short, 25 sessions: RSS / CPU     | Short, 250 sessions: RSS / CPU    | Delayed: RSS / CPU                |
| -------- | --------------------------------- | --------------------------------- | --------------------------------- |
| 1        | +38.8984 MiB / -12.1562 points    | +24.9609 MiB / -14.1598 points    | +16.8438 MiB / +0.8000 points     |
| 2        | **+86.1055 MiB** / -3.8005 points | +49.6250 MiB / **+1.7920 points** | -10.1914 MiB / **+1.1999 points** |
| 3        | +4.8086 MiB / -6.2107 points      | -48.5078 MiB / -1.9959 points     | +17.4414 MiB / -0.4002 points     |

Budgets remain median **+64 MiB RSS / +1.0 CPU point** of one core. All three campaigns were
required to pass; two passing campaigns do not compensate for campaign 2. No rerun replaces it.

The separate 20-minute baseline and 20-minute sidebar observations completed 21 checkpoints each.
Endpoint differences were +34.9180 MiB RSS / +0.8200 CPU points; RSS fell during both observations.
The 50 activation/deactivation cycles plus final disposal produced 51 cleanup receipts with zero
live public event subscriptions, pending health requests, health failures, post-disposal health
calls, or post-disposal delivered events. These observations do not establish allocation ownership,
absence of leaks, or override the failed gates. See the
[machine-readable summary](validation/v1-integration-candidate.json).

## Reproduce the candidate checks

From the candidate checkout, using a fresh output directory outside it:

```sh
bun install --frozen-lockfile
bun run check
bun run package:check
echo 'a91d70019f34307548355234859f80130bac1cc8483adee6bdcc9535bf1a472d  dist/tui.js' | sha256sum --check

# Use absolute paths for the pinned host executable and receipts.
OPENCODE_BIN=/absolute/path/to/opencode-1.19.3 \
SIDEBAR_TEST_OPENCODE_VERSION=1.19.3 \
SIDEBAR_PACKAGE_REPORT=/absolute/path/to/evidence/package.json \
bun run smoke:package

OPENCODE_BIN=/absolute/path/to/opencode-1.19.3 \
SIDEBAR_TEST_OPENCODE_VERSION=1.19.3 \
SIDEBAR_REMOTE_REPORT=/absolute/path/to/evidence/remote.json \
bun scripts/smoke-sidebar-remote.ts

npm pack --ignore-scripts --pack-destination /absolute/path/to/artifacts
sha256sum /absolute/path/to/artifacts/opencode-sessions-sidebar-0.1.0-dev.0.tgz
git rev-parse HEAD
```

Keep the tarball checksum and source SHA together. Documentation changes can change the tarball
checksum while preserving the verified runtime hash. Installation from this archive requires no
development dependencies or second Solid/OpenTUI runtime. The receipt names its exact tested
archive; do not claim an older archive checksum for a newly packed file.

## Handoff to an isolated Ubuntu/Compose installation

Prepare a **new Compose project with its own writable volumes** for OpenCode configuration, native
sessions, working projects and sidebar state. Start with SSH into Ubuntu and `docker compose exec`
into that container; no OpenCode/Bun installation is needed on the Mac and no HTTP port needs to be
published for this first trial. Keep the existing installations and runner workspaces outside its
mounts. Docker lifecycle and the harness installation belong to that deployment's runbook.

Before combining components, record the exact harness candidate commit and its expected OpenCode
version. Use 1.19.3 only if that candidate declares it; otherwise perform a compatibility check for
its actual version first. A moving harness `main` or an unsigned/unpublished local change is not a
substitute for identifying the candidate. The sidebar evidence alone is not combined-harness
validation.

Inside the new container, first run the harness's installation plan and verification against its own
isolated profile. Retain its installation receipt. Install the sidebar archive in a separate
consumer directory (for example `/opt/sidebar-candidate`, owned by the container user):

```sh
cd /opt/sidebar-candidate
npm init -y
npm install --offline --ignore-scripts --omit=dev --no-audit --no-fund \
  /artifacts/opencode-sessions-sidebar-0.1.0-dev.0.tgz
echo 'a91d70019f34307548355234859f80130bac1cc8483adee6bdcc9535bf1a472d  node_modules/opencode-sessions-sidebar/dist/tui.js' | sha256sum --check
```

Use the archive's supplied checksum before installing. Do not mount provider credentials until the
provider-free checks have passed. A later model-backed integration session is a separate step.

### Exactly one sidebar

Stop the test OpenCode process before changing its profile. Back up its `opencode.json` and
`tui.json`, and inventory any old sidebar plugin files. Backups must live **outside** OpenCode's
autoloaded `plugins/` directory; renaming a plugin to another `.js` filename inside that directory
can still load it.

In the **isolated installed profile only**, remove the legacy sidebar entry from both explicit
plugin lists, and move its autoloadable entrypoint outside `plugins/`. Preserve the other harness
plugins and configuration. Do not delete its state or edit the harness source/bundles. Record this
as an integration overlay: the harness verifier may correctly report those installed-file changes.
Do not disable that verifier or describe the modified installation as byte-identical to its receipt.

Add the following entry to the existing `plugin` array in the test profile's **`tui.json`**,
preserving all other keys and entries. Do not put it in the server `opencode.json` plugin array.
Resolve the paths for the user running the TUI in the container:

```json
{
  "plugin": [
    [
      "file:///opt/sidebar-candidate/node_modules/opencode-sessions-sidebar/dist/tui.js",
      {
        "hostId": "ubuntu-v1-trial",
        "storageDirectory": "/home/node/.local/state/sidebar-v1-trial",
        "icons": "ascii",
        "density": "balanced"
      }
    ]
  ]
}
```

The fragment is not a replacement for the whole TUI configuration. Keep `hostId` stable across
ordinary restarts and give separate servers different identities. Sidebar state must be private
local storage on the machine running the TUI, with a persistent volume. Legacy pins/queue state has
no automatic migration into this plugin; retain it for rollback and start with synthetic data.

ASCII is the first portable check. The optional Nerd Font must be selected on the **displaying
Mac/terminal**, even though the TUI runs on Ubuntu. Installing a font only inside the container
cannot control SSH client glyphs. See [terminal fonts](terminal-fonts.md).

### Joint trial and rollback

Record the container image identity, both source revisions, package hash, OpenCode version and
terminal dimensions. Verify one sidebar, active-row completion without an ellipsis, navigation,
pins, Later ordering, restart persistence, attention visibility, narrow-terminal fallback, remote
reconnect, and the harness's own agent/plugin checks. A provider-backed session must confirm that
the retained harness hooks and new sidebar coexist. Keep CPU/RSS observations separate from
inference or other load; the original performance blocker remains open.

For rollback, stop the test OpenCode process, restore the backed-up profile and legacy entrypoint,
and restart. Keep both state directories and evidence. `docker compose down` preserves named
volumes; do not add `--volumes` unless deliberately discarding this trial. No rollback step should
change an existing production installation.

## Promotion conditions

Stable V1 promotion remains blocked by repeatable resource acceptance, an identified exact harness
candidate and successful joint integration, and any additional host/platform compatibility claimed
for that release. Do not weaken budgets, suppress failures, enable automatic merging, or call this
an npm release to make the candidate appear ready.
