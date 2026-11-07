/** Bounded inspection of the TrueType tables needed by the pinned font bundle. */
export function inspectFontCoverage(
  bytes: Uint8Array,
  codepoints: readonly number[],
  outlineCodepoints?: readonly number[],
) {
  if (bytes.length < 12 || bytes.length > 20 * 1024 * 1024)
    throw new Error("Invalid TrueType font size.");
  if (
    codepoints.length > 4096 ||
    (outlineCodepoints?.length ?? 0) > 4096 ||
    [...codepoints, ...(outlineCodepoints ?? [])].some(
      (cp) => !Number.isInteger(cp) || cp < 0 || cp > 0x10ffff,
    )
  )
    throw new Error("Invalid font coverage request.");
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bound = (offset: number, size: number, end = bytes.length) => {
    if (offset < 0 || size < 0 || offset + size > end || end > bytes.length)
      throw new Error("Truncated or invalid TrueType table.");
  };
  const u16 = (offset: number) => {
    bound(offset, 2);
    return data.getUint16(offset);
  };
  const u32 = (offset: number) => {
    bound(offset, 4);
    return data.getUint32(offset);
  };
  if (u32(0) !== 0x00010000) throw new Error("Only standalone TrueType fonts are supported.");
  const count = u16(4);
  if (count === 0 || count > 64) throw new Error("Invalid TrueType table count.");
  bound(12, count * 16);
  const tables = new Map<string, { start: number; end: number }>();
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16;
    const name = String.fromCharCode(...bytes.subarray(at, at + 4));
    const start = u32(at + 8),
      length = u32(at + 12);
    bound(start, length);
    if (tables.has(name) || start < 12 + count * 16)
      throw new Error("Invalid TrueType table directory.");
    tables.set(name, { start, end: start + length });
  }
  const table = (name: string, minimum: number) => {
    const value = tables.get(name);
    if (!value) throw new Error(`Missing TrueType ${name} table.`);
    bound(value.start, minimum, value.end);
    return value;
  };
  const maxp = table("maxp", 6),
    hhea = table("hhea", 36),
    hmtx = table("hmtx", 4);
  const glyphCount = u16(maxp.start + 4),
    metrics = u16(hhea.start + 34);
  if (glyphCount === 0 || metrics === 0 || metrics > glyphCount)
    throw new Error("Invalid TrueType metrics.");
  bound(hmtx.start, metrics * 4 + (glyphCount - metrics) * 2, hmtx.end);
  const advance = (glyph: number) => {
    if (glyph <= 0 || glyph >= glyphCount) return 0;
    return u16(hmtx.start + Math.min(glyph, metrics - 1) * 4);
  };
  const cmap = table("cmap", 4),
    encodingCount = u16(cmap.start + 2);
  if (encodingCount === 0 || encodingCount > 64) throw new Error("Invalid TrueType cmap count.");
  bound(cmap.start + 4, encodingCount * 8, cmap.end);
  const candidates: Array<{ start: number; end: number; format: number; priority: number }> = [];
  for (let i = 0; i < encodingCount; i++) {
    const at = cmap.start + 4 + i * 8,
      platform = u16(at),
      encoding = u16(at + 2);
    if (platform !== 0 && !(platform === 3 && [1, 10].includes(encoding))) continue;
    const start = cmap.start + u32(at + 4);
    bound(start, 4, cmap.end);
    const format = u16(start);
    if (format !== 4 && format !== 12) continue;
    bound(start, format === 12 ? 16 : 16, cmap.end);
    const length = format === 12 ? u32(start + 4) : u16(start + 2);
    bound(start, length, cmap.end);
    if (length < 16) throw new Error("Invalid Unicode cmap length.");
    candidates.push({
      start,
      end: start + length,
      format,
      priority: (format === 12 ? 10 : 0) + (platform === 3 ? 1 : 0),
    });
  }
  const selected = candidates.sort((a, b) => b.priority - a.priority)[0];
  if (!selected) throw new Error("No supported Unicode cmap in font.");
  const { start, end, format } = selected;
  let lookup: (cp: number) => number;
  if (format === 12) {
    const groups = u32(start + 12);
    if (groups > 65536) throw new Error("Too many Unicode cmap groups.");
    bound(start + 16, groups * 12, end);
    let previous = -1;
    for (let i = 0; i < groups; i++) {
      const at = start + 16 + i * 12,
        first = u32(at),
        last = u32(at + 4);
      if (
        first <= previous ||
        first > last ||
        last > 0x10ffff ||
        u32(at + 8) + last - first >= glyphCount
      )
        throw new Error("Invalid Unicode cmap group.");
      previous = last;
    }
    lookup = (cp) => {
      let low = 0,
        high = groups - 1;
      while (low <= high) {
        const middle = (low + high) >>> 1,
          at = start + 16 + middle * 12;
        if (cp < u32(at)) high = middle - 1;
        else if (cp > u32(at + 4)) low = middle + 1;
        else return u32(at + 8) + cp - u32(at);
      }
      return 0;
    };
  } else {
    const segmentsX2 = u16(start + 6),
      segments = segmentsX2 / 2;
    if (segmentsX2 === 0 || segmentsX2 % 2 !== 0) throw new Error("Invalid Unicode cmap segments.");
    bound(start + 14, segments * 8 + 2, end);
    const ends = start + 14,
      starts = ends + segments * 2 + 2;
    const deltas = starts + segments * 2,
      offsets = deltas + segments * 2;
    let previous = -1;
    for (let i = 0; i < segments; i++) {
      const first = u16(starts + i * 2),
        last = u16(ends + i * 2);
      if (first <= previous || first > last) throw new Error("Invalid Unicode cmap segment order.");
      previous = last;
      const offset = u16(offsets + i * 2);
      if (offset) bound(offsets + i * 2 + offset, (last - first + 1) * 2, end);
    }
    lookup = (cp) => {
      if (cp > 0xffff) return 0;
      for (let i = 0; i < segments; i++) {
        if (cp > u16(ends + i * 2)) continue;
        if (cp < u16(starts + i * 2)) return 0;
        const delta = u16(deltas + i * 2),
          offset = u16(offsets + i * 2);
        if (!offset) return (cp + delta) & 0xffff;
        const glyph = u16(offsets + i * 2 + offset + (cp - u16(starts + i * 2)) * 2);
        return glyph ? (glyph + delta) & 0xffff : 0;
      }
      return 0;
    };
  }
  const cellAdvance = advance(lookup(0x4d));
  if (!cellAdvance) throw new Error("The font must provide a nonzero-width Latin M.");
  const missing: number[] = [],
    differentAdvance: number[] = [];
  for (const cp of new Set(codepoints)) {
    const glyph = lookup(cp);
    if (!glyph || glyph >= glyphCount) missing.push(cp);
    else if (advance(glyph) !== cellAdvance) differentAdvance.push(cp);
  }
  if (outlineCodepoints === undefined) return { cellAdvance, missing, differentAdvance };
  // Advance width alone does not prove that a glyph fits in one terminal cell.
  // Check the stored TrueType outline bounds without interpreting/rasterizing contours.
  const head = table("head", 54),
    formatLoca = data.getInt16(head.start + 50);
  if (formatLoca !== 0 && formatLoca !== 1) throw new Error("Invalid TrueType loca format.");
  const loca = table("loca", (glyphCount + 1) * (formatLoca === 0 ? 2 : 4)),
    glyf = table("glyf", 0);
  const offsetFor = (glyph: number) =>
    formatLoca === 0 ? u16(loca.start + glyph * 2) * 2 : u32(loca.start + glyph * 4);
  let previousOffset = 0;
  for (let glyph = 0; glyph <= glyphCount; glyph++) {
    const offset = offsetFor(glyph);
    if (offset < previousOffset || offset > glyf.end - glyf.start)
      throw new Error("Invalid TrueType glyph offsets.");
    previousOffset = offset;
  }
  const outsideCell: number[] = [];
  for (const cp of new Set(outlineCodepoints)) {
    const glyph = lookup(cp);
    if (!glyph || glyph >= glyphCount) throw new Error("Missing outline glyph.");
    const start = glyf.start + offsetFor(glyph),
      end = glyf.start + offsetFor(glyph + 1);
    if (start === end) continue; // Empty glyphs such as ASCII space have no outline.
    bound(start, 10, end);
    const xMin = data.getInt16(start + 2),
      yMin = data.getInt16(start + 4),
      xMax = data.getInt16(start + 6),
      yMax = data.getInt16(start + 8);
    if (xMin > xMax || yMin > yMax) throw new Error("Invalid TrueType glyph bounds.");
    if (xMin < 0 || xMax > cellAdvance) outsideCell.push(cp);
  }
  return { cellAdvance, missing, differentAdvance, outsideCell };
}

export function assertFontCoverage(
  bytes: Uint8Array,
  codepoints: readonly number[],
  outlineCodepoints?: readonly number[],
): void {
  const result = inspectFontCoverage(bytes, codepoints, outlineCodepoints);
  const label = (values: number[]) =>
    values.map((cp) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`).join(", ");
  if (result.missing.length)
    throw new Error(`Font is missing sidebar glyphs: ${label(result.missing)}.`);
  if (result.differentAdvance.length)
    throw new Error(`Font has inconsistent glyph advances: ${label(result.differentAdvance)}.`);
  if (result.outsideCell?.length)
    throw new Error(`Font outlines exceed one terminal cell: ${label(result.outsideCell)}.`);
}
