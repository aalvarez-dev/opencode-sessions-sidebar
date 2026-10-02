# Optional terminal fonts

This directory contains a download manifest and unchanged upstream notices, not font binaries. The
development helper downloads the four pinned styles only when explicitly requested; the sidebar,
build, tests, and dependency installation do not download or install them.

- Family: **JetBrainsMono Nerd Font Mono** (legacy family name **JetBrainsMono NFM**).
- Base font: JetBrains Mono **2.304**.
- Patched release: Nerd Fonts **3.4.0**, commit `fa7b859994228a9c8759f99c55a8d31ee92a1b5e`.
- Source:
  [official pinned repository](https://github.com/ryanoasis/nerd-fonts/tree/fa7b859994228a9c8759f99c55a8d31ee92a1b5e/patched-fonts/JetBrainsMono).
- Styles: Regular, Bold, Italic, and BoldItalic, all using the **Mono** variant.
- Integrity: exact byte lengths and SHA-256 values in [manifest.json](manifest.json), calculated
  from the official commit-addressed downloads. These are project integrity pins, not claims of an
  independent upstream signature.

The manifest preserves each upstream path. Font bytes are not changed, subsetted, or renamed. The
helper places these notices beside downloaded files:

- [JetBrains Mono OFL and copyright](licenses/JetBrainsMono-OFL.txt).
- [JetBrains Mono authors](licenses/JetBrainsMono-AUTHORS.txt).
- [Nerd Fonts licensing and attribution](licenses/NerdFonts-LICENSE.txt).

The fonts retain their own licenses; the sidebar's MIT license does not replace them. Preserve the
notices and embedded font metadata when redistributing prepared files. See the upstream
[license audit](https://github.com/ryanoasis/nerd-fonts/blob/fa7b859994228a9c8759f99c55a8d31ee92a1b5e/license-audit.md)
for the included glyph sources.

Use [the terminal setup guide](../../docs/terminal-fonts.md) for preparation and selection. This
deliberate version pin is not a claim to follow the newest Nerd Fonts release. A future update must
review source/license changes, regenerate hashes from official files, and verify glyph coverage.
