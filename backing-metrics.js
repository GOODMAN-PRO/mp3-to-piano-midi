// Measure missing accompaniment against the non-N chord timeline, including
// partial holes inside voiced segments. N/silence is not counted as missing.
export function backingCoverage(notes, chords = notes.chords, offset = notes.timingOffsetSeconds ?? 0) {
  if (!Array.isArray(chords)) return { noBackingPct: null, longestNoBackingSeconds: null };
  const merge = spans => {
    const out = [];
    for (const [start, end] of spans.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
      .sort((a, b) => a[0] - b[0])) {
      if (out.length && start <= out.at(-1)[1] + 1e-9) out.at(-1)[1] = Math.max(out.at(-1)[1], end);
      else out.push([start, end]);
    }
    return out;
  };
  const active = merge(chords.filter(c => c.label !== 'N' && c.root !== null)
    .map(c => [Math.max(0, c.start - offset), Math.max(0, c.end - offset)]));
  const backing = merge(notes.filter(n => n.role && n.role !== 'melody')
    .map(n => [n.startTimeSeconds, n.end ?? n.startTimeSeconds + n.durationSeconds]));
  let total = 0, missing = 0, longest = 0;
  for (const [start, end] of active) {
    total += end - start;
    let cursor = start;
    for (const [a, b] of backing) {
      if (b <= cursor) continue;
      if (a >= end) break;
      const gap = Math.max(0, a - cursor);
      missing += gap; longest = Math.max(longest, gap);
      cursor = Math.min(end, Math.max(cursor, b));
    }
    const tail = end - cursor;
    missing += tail; longest = Math.max(longest, tail);
  }
  return { noBackingPct: total ? 100 * missing / total : 0, longestNoBackingSeconds: longest };
}
