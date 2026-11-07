# Portable terminal icons on Ubuntu and macOS

The sidebar renders text characters, not embedded images. The terminal that displays them chooses
font glyphs and cell metrics. A font installed only on an SSH server or in Docker does not configure
the client terminal. Install/select the verified font on **the computer displaying the terminal**.
The setup below is optional; plugin activation never downloads fonts or edits terminal settings.

## Complete font profile

The pinned profile now uses **Iosevka Nerd Font Mono Regular**, base **33.2.1**, patched by Nerd
Fonts **3.4.0**. One unchanged upstream TTF is approximately **13.1 MB**. The regular face covers
all sidebar controls, status symbols, Braille animation frames, and ordinary ASCII. The old optional
JetBrains Mono profile lacked the retry arrow and Braille characters. Glyph outlines follow the
selected font rather than an unspecified system fallback. The approved presentation uses a pin,
clock, and trash can for its controls; Nerd mode provides those shapes. Compatibility modes retain
their explicit text substitutes.

The shared [icon catalog](../src/ui/icons.ts) defines symbol text and expected terminal-cell widths.
Font preparation verifies its complete union of ASCII/Unicode/Nerd glyphs plus ordinary ASCII and UI
punctuation. It checks the pinned file hash, a bounded TrueType Unicode `cmap`, and `hmtx` glyph
advances against the font's Latin `M`. For every Nerd-mode control and animation frame, it also
checks the stored `glyf` horizontal bounds through bounded short/long `loca` tables: the outline
must fit between zero and one cell's advance. It does not trust the name of an installed font as
evidence of coverage. No Python, FontTools, font editor, or runtime patching is required by this
helper. This is a bounds check, not a replacement for native pixel review or a font rasterizer.

Font advances are not terminal width negotiation: the Unicode hourglass can occupy two terminal
cells even though its outline has the same advance as other font glyphs. The icon catalog preserves
that distinction. Terminals can also draw Braille or other symbols themselves, synthesize styles, or
use emoji presentation. Complete font coverage does not guarantee identical pixels on every
terminal, display, theme, or scaling setting.

Only the regular face is distributed, keeping the optional download small compared with a full style
family. Current icon runs use regular text. The terminal may synthesize bold/italic text; check
styled text in your terminal rather than assuming native style rendering has been certified.

| Sidebar option       | Use                                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `"icons": "nerd"`    | Uses the pinned font's pin, filled/outline Later clocks, and trash can, with the common status/animation symbols. |
| `"icons": "unicode"` | Retains the default Unicode controls. The pinned font covers these as well.                                       |
| `"icons": "ascii"`   | Explicit fallback for icon/animation compatibility; other UI text and session titles can still contain Unicode.   |

Put the option in the sidebar settings in `tui.json`, following
[sidebar setup](sidebar-validation.md). A menu selection only lasts for the current activation; put
your desired initial mode in configuration. Font setup does not silently change the icon mode.

The clock pair is Octicons `clock-fill` (`U+F4AB`) and `clock` (`U+F43A`) from the
[pinned Nerd Fonts glyph map](https://github.com/ryanoasis/nerd-fonts/blob/fa7b859994228a9c8759f99c55a8d31ee92a1b5e/glyphnames.json).
The two outlines preserve the active/inactive distinction without depending only on color. The
compact child tree uses single-cell `├`, `└`, and `│`, with printable ASCII substitutes in ASCII
mode. Both the controls and tree connectors participate in font coverage and visual cell guides.

Nerd mode also uses fitted Codicons for the completion check (`U+EAB2`), menu/truncation ellipsis
(`U+EA7C`), retry loop (`U+EA77`), and down/right disclosures (`U+EB6E`/`U+EB70`), plus Octicons
`arrow-up-right` (`U+F46C`) for a session shown elsewhere. Unicode and ASCII modes keep their
existing semantic substitutes. Native xterm review exposed why matching advances alone was
insufficient: the unchanged pinned font's Unicode outlines extend beyond their 500-unit cell:

| Unicode glyph            | Stored horizontal bounds |
| ------------------------ | ------------------------ |
| Completion `U+2713`      | 190–813                  |
| Ellipsis `U+2026`        | 89–911                   |
| Retry `U+21BB`           | 136–864                  |
| Expanded `U+25BE`        | 277–723                  |
| Collapsed `U+25B8`       | 316–684                  |
| Shown elsewhere `U+2197` | 105–883                  |

The Nerd replacements fit entirely within that cell. They preserve control/state meaning and avoid
clipping the check or losing ellipsis dots in a cell-clipping terminal. The outline gate covers the
complete Nerd catalog, including animation frames; it does not claim that arbitrary Unicode text or
another selected font fits the same bounds.

## Prepare or transfer the bundle

From a development checkout, use Bun **1.3.14** and a **new** directory with an existing parent:

```sh
bun run fonts:prepare --download ./sidebar-fonts
bun run fonts:prepare --verify ./sidebar-fonts
```

The download is explicit, commit-addressed, timeout/size-bounded, and SHA-256 checked. All font and
license bytes and required glyphs verify before creating the destination. Existing destinations are
refused. Verification is offline and also compares the prepared manifest with this package's
manifest. A failed write can leave an incomplete directory for inspection; it never passes
verification or gets silently overwritten.

The resulting directory contains the font, exact manifest, and unchanged upstream licenses. You can
transfer the whole directory to another computer and verify it there. Keep the notices with the
font. Nothing is installed by downloading or copying this bundle. The source repository and ordinary
package contain the manifest/helper/notices, not the 13.1 MB font binary; an offline installation
needs this separately prepared bundle.

The packaged helper is available at `dist/prepare-fonts.js`. Its equivalent invocation is
`bun /path/to/package/dist/prepare-fonts.js --verify /path/to/sidebar-fonts`; it does not require
this repository's development dependencies.

## Preview and install for your user

Run on the display computer, as its ordinary desktop user:

```sh
bun run fonts:prepare --install ./sidebar-fonts
bun run fonts:prepare --install ./sidebar-fonts --apply
```

The first command verifies the bundle and prints a plan without creating directories. `--apply`
explicitly copies the verified bytes, licenses, manifest, and a receipt into a versioned user
folder:

| System       | Font destination                                              |
| ------------ | ------------------------------------------------------------- |
| Ubuntu/Linux | `~/.local/share/fonts/opencode-sessions-sidebar/<bundle-id>/` |
| macOS        | `~/Library/Fonts/opencode-sessions-sidebar/<bundle-id>/`      |

The helper never uses `sudo`, installs system-wide fonts, overwrites a different/partial bundle, or
changes terminal preferences. A matching installation is reused. Directory and file symlinks are
refused. A custom Linux `XDG_DATA_HOME` is left to your desktop font manager instead of guessing a
font location. The receipt identifies installed file hashes and confirms terminal settings were not
edited. For removal, close applications using the font and remove only this versioned bundle through
your font manager or file manager; leave other user fonts alone.

An SSH session is refused unless you explicitly add `--display-machine`, acknowledging that the
current computer also displays the terminal. That option does **not** install anything on an SSH
client. For a Mac connected to Ubuntu, run setup on the Mac. Container placement alone is likewise
insufficient.

On Linux, explicitly refresh only this directory's font cache if necessary:

```sh
bun run fonts:prepare --install ./sidebar-fonts --apply --refresh-cache
```

This invokes `fc-cache` directly with a bounded timeout. If it is unavailable or fails, the verified
font files remain installed and the command reports that cache refresh still needs attention. On
macOS, reopen the terminal after placement. If Font Book has not registered the font, open the
prepared `.ttf` in Font Book and install it for your user. Native OS registration remains part of
the platform acceptance checklist below.

## Select your terminal's font

The helper prints settings or instructions without applying them:

```sh
bun run fonts:prepare --config ghostty
bun run fonts:prepare --config gnome
bun run fonts:prepare --config terminal
bun run fonts:prepare --config vscode
```

- **Ghostty (Ubuntu/macOS):** explicitly select `Iosevka Nerd Font Mono`. The generated full-profile
  snippet resets an earlier fallback list, so review it before adding it. `ghostty +list-fonts`
  helps confirm the installed family. Alternatively, Ghostty's `font-codepoint-map` can assign just
  the sidebar symbols to this family while preserving your preferred text font. Open a new window
  after applying font settings.
- **GNOME Terminal (Ubuntu):** Preferences → your profile → Text → Custom font; choose the family
  and your preferred size. Apply to the profile you actually use.
- **Terminal (macOS):** Settings → Profiles → Text → Font → Change; select the family, then open a
  window using that profile.
- **VS Code:** set `terminal.integrated.fontFamily` to `'Iosevka Nerd Font Mono', monospace` in the
  appropriate user/profile settings. The font must exist where the terminal is rendered. A browser
  Codespace does not acquire local fonts by installing them in its remote container.

Some selectors show the legacy family **Iosevka NFM**. Resolve duplicate versions of this family in
your OS font manager before comparing terminals. Do not infer that the intended font loaded merely
because ordinary text is readable.

## Verify the actual terminal

Open **Sessions sidebar: check icons** through the command palette. The sample shows controls, state
glyphs, every animation frame, and cell guides side by side for all three modes. Choose a mode
explicitly if glyphs are missing or alignment differs. This is visual verification by the person
viewing the terminal, not automatic discovery of its font.

Then verify normal/completed/busy/retry rows; active/inactive pin and Later controls; disclosure,
menu, and delete; long titles; and narrow/wide layouts. Confirm icons and click targets stay aligned
and attention remains visible. Keep the same OpenCode theme, density, and icon mode when comparing
platforms. `reducedMotion: true` provides static activity glyphs.

The bundled parser was independently checked against the official font with FontTools during
implementation. The revised clock and compact-tree catalog passes the pinned file's integrity,
coverage, advance, and Nerd-outline checks: all **146** required codepoints are present with a
**500-unit** advance, and all **38** distinct Nerd glyph/animation codepoints fit horizontally.
Fixture tests cover TrueType cmap formats 4/12, missing glyphs, inconsistent advances, malformed
bounds, offline integrity checks, dry-run, repeated placement, conflicts, and symlink refusal. Tests
use temporary directories, not the tester's actual font folders. They establish preparation and
placement behavior. The isolated campaign has captured genuine xterm windows with the pinned font,
and a macOS Terminal.app pilot with its default font. The latter visibly demonstrates why ASCII is
needed when the selected font lacks Nerd glyphs. These named configurations do not establish
universal terminal compatibility.

The macOS workflow also has a separate selected-font scenario. It creates a uniquely named
`.terminal` profile on a disposable GitHub-hosted runner, archives the resolved AppKit `NSFont`,
verifies its round trip and CoreText font-file SHA-256, and launches only that profile's synthetic
command through LaunchServices. It does not replace the default profile or change privacy
permissions. If ordinary user-font placement has not registered the family, the test can explicitly
register that same verified file for the current disposable session and unregister only its own
registration during cleanup. The non-default imported profile belongs to the ephemeral runner and is
discarded with it; this is not a client setup operation.

The default-font and selected-font cases retain separate passed/blocked/failed receipts. The job
requires both cases to pass, so a blocked capability cannot be mistaken for graphical acceptance.
The public Swift observation helper is compiled once in a separate preparation step with a
120-second limit. Both cases verify its source/binary hash receipt before reuse, keeping cold SDK
compilation outside their unchanged 240-second graphical deadlines. The first selected-font hosted
case rendered genuine pinned-font pixels; the preceding default-font case timed out during cold
compilation. That blocked attempt remains evidence, not an ASCII acceptance result. The
profile/archive receipt establishes the requested font selection; genuine PNGs still require visual
review for missing glyphs and alignment. A larger requested viewport helps expose the group order
without editing native onboarding state. This pilot remains narrower than full macOS input,
attention, remote transport or Ghostty acceptance. Per-capture observation timings and visible
session-data health warnings are retained explicitly; warnings are not hidden by retrying until a
healthy frame appears, and the font pilot never declares transport acceptance.

## Primary references

- [Pinned upstream Iosevka font and license](https://github.com/ryanoasis/nerd-fonts/tree/fa7b859994228a9c8759f99c55a8d31ee92a1b5e/patched-fonts/Iosevka).
- [Ghostty font configuration](https://ghostty.org/docs/config/reference).
- [GNOME Terminal font selection](https://help.gnome.org/users/gnome-terminal/stable/app-fonts.html.en).
- [Apple Terminal profile text settings](https://support.apple.com/guide/terminal/change-profiles-text-settings-trmltxt/mac).
- [Apple Terminal profile documents](https://support.apple.com/guide/terminal/import-and-export-terminal-profiles-trml4299c696/mac).
- [Apple keyed font archives](<https://developer.apple.com/documentation/foundation/nskeyedarchiver/archiveddata(withrootobject:requiringsecurecoding:)>).
- [CoreText font-file identity](<https://developer.apple.com/documentation/coretext/ctfontcopyattribute(_:_:)>).
- [CoreText session registration](https://developer.apple.com/documentation/coretext/ctfontmanagerscope/session).
- [VS Code terminal appearance](https://code.visualstudio.com/docs/terminal/appearance).
