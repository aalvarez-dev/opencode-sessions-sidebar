# Portable terminal font bundle

This directory contains a download manifest and unchanged upstream notices. The helper prepares the
optional font bundle only when explicitly requested. Plugin activation, dependency installation,
builds, and ordinary tests do not download or install fonts.

- Family: **Iosevka Nerd Font Mono**, legacy family **Iosevka NFM**.
- Base: Iosevka **33.2.1**; patched by Nerd Fonts **3.4.0**.
- Pinned commit: `fa7b859994228a9c8759f99c55a8d31ee92a1b5e`.
- [Official unchanged Regular TTF](https://github.com/ryanoasis/nerd-fonts/blob/fa7b859994228a9c8759f99c55a8d31ee92a1b5e/patched-fonts/Iosevka/IosevkaNerdFontMono-Regular.ttf).
- Download size: **13,135,052 bytes**. Only the regular face is needed for current icon runs; the
  terminal may synthesize other text styles.
- Integrity: exact byte count and SHA-256 in [manifest.json](manifest.json). These are project pins,
  not an upstream signature or a claim to track the newest font release.

The shared icon catalog drives verification of the actual TTF's Unicode cmap and glyph advances. All
current controls, status glyphs, animation frames, ASCII, and required punctuation are covered in
this family. The previous optional JetBrains Mono profile lacked retry/Braille coverage; its
existing notice files are retained, but it is no longer the recommended downloadable bundle. The
original symbol codepoints are preserved; the selected font determines their outlines.

Font bytes are not modified, subsetted, or renamed. The prepared bundle preserves these notices:

- [Iosevka OFL/copyright](licenses/Iosevka-LICENSE.txt).
- [Nerd Fonts licensing and attribution](licenses/NerdFonts-LICENSE.txt).

The font's licenses remain separate from the sidebar's MIT license. Preserve the notices and
embedded metadata when transferring or redistributing the bundle. See the upstream
[license audit](https://github.com/ryanoasis/nerd-fonts/blob/fa7b859994228a9c8759f99c55a8d31ee92a1b5e/license-audit.md)
for included symbol sources.

See [terminal font setup](../../docs/terminal-fonts.md) for explicit preparation, offline
verification, current-user placement on Ubuntu/macOS, terminal configuration, and the visual check.
Font coverage is evidence about the file; it does not prove which font a native or remote terminal
is displaying.
