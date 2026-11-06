# Development package and release validation

The package is still **private**, version `0.1.0-dev.0`. A local `.tgz` is a reviewable development
artifact; creating or testing it does not publish to npm or declare a stable V1 release. OpenCode
**1.18.30** and Bun **1.3.14** are the current validation baseline. Other host releases, native
terminal fonts, and remote transport behavior require their own evidence.

## Build and inspect the distributable

From the source checkout:

```sh
bun install --frozen-lockfile
bun run check
bun run package:check
```

`package:check` requires npm. It builds a local archive with `npm pack --ignore-scripts`, using the
already-built `dist` directory, then installs that archive offline into a temporary empty consumer.
The consumer has no checkout source, development dependencies, or separately installed Solid/OpenTUI
runtime. The check verifies package contents, export and declaration targets, imports the headless
entrypoints, and runs the packaged font helper's help and terminal-configuration output against its
installed manifest. The temporary consumer and archive are removed afterward. Package creation and
installation never run lifecycle scripts.

The distribution boundary is `dist/`, `assets/fonts/`, `docs/`, `README.md`, `CHANGELOG.md`,
`LICENSE`, and the package manifest, plus the local JavaScript extension examples. Tests, CI
configuration, local lab data, personal configuration, and development dependencies are excluded.
The validation rejects unexpected files and artifacts over 25 MiB. The font directory includes its
pinned source manifest and license notices; font preparation and installation remain explicit
operations described in [terminal font setup](terminal-fonts.md).

To keep an archive for a separate test machine, create a destination directory outside the checkout
and run:

```sh
npm pack --ignore-scripts --pack-destination /absolute/path/to/artifacts
```

Do this after a successful build and package check. Record the archive's SHA-256 and the source
revision alongside the test results; a version string alone cannot identify a development build.

## Exercise the installed artifact in stock OpenCode

```sh
OPENCODE_BIN=/absolute/path/to/opencode bun run smoke:package
```

This repeats the fresh offline installation and runs both existing stock-host sidebar probes with
`SIDEBAR_PLUGIN_FILE` pointing to the installed package's `dist/tui.js`. The ordinary input,
navigation, organization, and restart scenarios run first; the native attention scenarios run
second. The host probes use isolated configuration and synthetic sessions. Native attention uses the
existing deterministic loopback provider, with no external model or provider credentials.

Set `SIDEBAR_PACKAGE_REPORT` to an absolute JSON filename with an existing parent to retain the
receipt. It records the tarball hash, installed file hashes, package checks, and—when requested—the
native probe receipts. Each native receipt distinguishes harness/source hashes from the actual
installed runtime artifact. Failed checks remain failures; successful installation alone is not
evidence that the host loaded or rendered the plugin. Do not run resource measurements concurrently
with other native probes.

## Try a retained package manually

Create a fresh, disposable directory and install the archive there:

```sh
npm init -y
npm install --offline --ignore-scripts --omit=dev --no-audit --no-fund /absolute/path/to/opencode-sessions-sidebar-0.1.0-dev.0.tgz
```

In a separate OpenCode test profile, configure the explicit installed TUI entrypoint:

```json
{
  "plugin": [
    [
      "file:///absolute/path/to/consumer/node_modules/opencode-sessions-sidebar/dist/tui.js",
      {
        "hostId": "synthetic-package-trial",
        "storageDirectory": "/absolute/path/to/private/sidebar-state",
        "icons": "ascii",
        "density": "balanced"
      }
    ]
  ]
}
```

Use the machine running the TUI for the module and storage paths. Install/select any optional font
on the computer displaying the terminal. OpenCode supplies the Solid/OpenTUI runtime; installing a
second copy in the consumer is unnecessary. Package-name discovery through a future npm release is a
distinct validation from this explicit-file loading procedure.

## Release acceptance

Before changing the private/version guard or publishing:

- Verify the intended completion policies and extension scenarios against confirmed host evidence.
  Keep unsupported execution correlation explicit.
- Pass the fresh package tests on the exact release content and document the supported host range.
- Record native Ubuntu/macOS terminal input and icon/font checks for the declared configurations.
- Complete the controlled rendered-sidebar performance and lifecycle comparison in
  [performance](performance.md), plus supported remote/disconnect scenarios.
- Review package contents, licenses, installation/uninstallation instructions, migration/recovery
  behavior, a changelog, and any remaining limitations.

Publishing a package, creating a release, merging a PR, and changing repository protections remain
separate actions. The validation scripts perform none of them.

## Recorded development package validation

The [November 6 installed-package receipt](validation/sidebar-package-runtime.json) passed the empty
offline consumer check and both stock OpenCode 1.18.30 probes: 17 sidebar/input checks and nine
native-attention checks, with five loopback provider requests. The package installed without
development dependencies or lifecycle scripts; all headless exports and the font helper resolved
from the consumer. The built TUI uses the host's Solid/OpenTUI runtimes.

The receipt identifies the exact tested archive and all 82 installed files. It was generated before
adding this evidence file and final documentation notes; those later documentation-only additions
change the archive hash, not the tested runtime artifact. CI repeats package checks and the
container's installed-artifact probes on the published PR head. This remains explicit-file loading
validation, not npm publication or package-name discovery.
