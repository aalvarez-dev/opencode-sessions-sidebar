# Optional terminal font setup

Use the same **JetBrainsMono Nerd Font Mono** files and sidebar icon mode on each computer to reduce
differences between terminals. The pinned family combines monospaced text and Nerd symbols in each
style, avoiding a separate icon fallback for the sidebar's private-use glyphs. Fonts belong on the
computer that displays the terminal: installing them on an SSH server or inside WSL does not
configure the Windows Terminal window.

This remains an experimental development plugin. The plugin cannot select the terminal's font or
guarantee identical pixels. Font rendering, display scaling, cell metrics, color profiles, host
themes, and some fallback glyphs still vary. Use the same OpenCode theme, density, icon mode, and
font files for a useful comparison; tune terminal font size for each display.

## Choose an icon mode

| Setting              | Font requirement                                   | Intended use                                                                |
| -------------------- | -------------------------------------------------- | --------------------------------------------------------------------------- |
| `"icons": "unicode"` | A font/terminal with the displayed Unicode symbols | Default, without a required font installation.                              |
| `"icons": "nerd"`    | A compatible Nerd Font                             | Consistent private-use pin, Later, and delete icons with the pinned family. |
| `"icons": "ascii"`   | Ordinary terminal text support                     | Fallback when glyphs are missing or widths disagree.                        |

Put the option in the existing sidebar options in `tui.json`, as shown in
[sidebar setup](sidebar-validation.md). Display settings can change the icon mode during the current
activation. Meaningful activity and attention also have text labels in Browse/session actions; the
optional font is not required to organize sessions. `reducedMotion: true` freezes activity
animations if preferred.

## Prepare the pinned files

From the development checkout, with Bun **1.3.14**, choose a **new** output directory whose parent
already exists. The same command syntax works in a POSIX shell and PowerShell:

```sh
bun run fonts:prepare --download ./sidebar-fonts
bun run fonts:prepare --verify ./sidebar-fonts
```

The first command downloads four styles, approximately 10 MB in total, from commit-addressed
official Nerd Fonts URLs. Each response has a size bound, a timeout, and an SHA-256 check. All font
and license bytes must verify before the destination is created. Existing destinations are rejected;
use `--verify` to check one again without network access. If a disk write fails after directory
creation, the incomplete folder remains for inspection and cannot pass verification.

Running `bun run fonts:prepare` without arguments only shows help. This optional preparation command
does not register fonts, refresh system caches, run a downloaded script, or change terminal
settings. Normal plugin activation, `bun install`, build, and tests never invoke it. No automatic
update is performed. Sources, hashes, and unchanged licenses are in
[the font manifest and notices](../assets/fonts/README.md).

## Install the prepared fonts explicitly

- **macOS:** open the four `.ttf` files in Font Book and install them for your user.
- **Windows:** select the four `.ttf` files in File Explorer and use **Install** for your user.
  Install on Windows itself when the shell runs inside WSL.
- **Linux:** use your desktop's font installer, or explicitly copy the four `.ttf` files to a user
  font directory such as `~/.local/share/fonts/sidebar/` and refresh the font cache with
  `fc-cache -f` if your environment uses fontconfig.

Keep the prepared license files with the downloaded originals. If the family is already installed
from a different release, resolve duplicate versions in your OS font manager before comparing
terminals. Restart the terminal after installation and confirm its font selector sees the family.
These are manual setup instructions, not steps performed by the plugin or preparation command.

## Ghostty example

Add these entries deliberately to your Ghostty configuration:

```ini
font-family = ""
font-family = "JetBrainsMono Nerd Font Mono"
font-size = 12
```

The empty value resets an earlier fallback list before selecting this family. Its regular, bold,
italic, and bold-italic files are supplied together. Check `ghostty +list-fonts` if the family is
not found; some font tools display its legacy name, `JetBrainsMono NFM`. Open a new window after
changing font configuration. Ghostty also supports `font-codepoint-map` for explicit symbol
overrides; the single patched family above does not need a separate Nerd symbol mapping.

## Windows Terminal example

In the target profile's Appearance settings, select **JetBrainsMono Nerd Font Mono**. Equivalently,
merge this `font` object into that profile in `settings.json`:

```json
{
  "font": {
    "face": "JetBrainsMono Nerd Font Mono",
    "size": 12,
    "weight": "normal"
  }
}
```

Use the exact installed family shown by the font selector; the legacy name may be shown as
**JetBrainsMono NFM**. Applying the example to one profile leaves other profiles under their
existing settings. Windows Terminal may fall back to Consolas when a requested family cannot be
found, so seeing ordinary text alone does not prove the selected font loaded.

## Verification and remaining limits

The pinned font metadata reports JetBrains Mono 2.304 and Nerd Fonts 3.4.0. Each of the four styles
contains the current private-use icon codepoints `U+EBA0`, `U+EB2B`, `U+F4E3`, `U+F451`, and
`U+F48E`. The helper's hashes verify exact files, not a terminal's active font choice.

The family does **not** contain the Unicode retry arrow `U+21BB` or Braille animation range
`U+2800–U+28FF` used by the current presentation, including Nerd mode. These can come from terminal
drawing or fallback fonts, so choosing this family alone cannot standardize every status glyph.
ASCII mode remains available if a terminal displays boxes, double-width symbols, or misalignment.
Nerd and Unicode modes retain their existing behavior; preparing a font changes no plugin state.

After selecting a font, check normal/completed/busy/retry rows, active/inactive pins and Later
controls, disclosure arrows, and a long title. Resize the terminal and confirm the visible controls
stay aligned and clickable. Compare the same host theme and density on each platform. Do not infer
macOS/Ghostty or Windows Terminal visual compatibility from a Linux download/hash check: actual
cross-platform rendering and OS font registration remain release-validation work.

## Primary references

- [Nerd Fonts pinned JetBrains Mono files](https://github.com/ryanoasis/nerd-fonts/tree/fa7b859994228a9c8759f99c55a8d31ee92a1b5e/patched-fonts/JetBrainsMono).
- [Ghostty configuration reference](https://ghostty.org/docs/config/reference).
- [Microsoft Windows Terminal profile appearance](https://learn.microsoft.com/en-us/windows/terminal/customize-settings/profile-appearance).
