import assert from 'node:assert/strict';
import { noteStats } from '../cli.mjs';
import { extractNotes } from '../extract.js';

const note = (pitch, hand, role, startTimeSeconds, durationSeconds) =>
  ({ pitch, hand, role, startTimeSeconds, durationSeconds, amplitude: 0.8, velocity: 0.8 });
const notes = [
  note(48, 'left', 'melody', 0, 1),
  note(60, 'left', 'melody', 1.2, 0.8),
  note(59, 'right', 'accompaniment', 0, 0.5),
  note(61, 'right', 'accompaniment', 0.2, 0.5),
  note(72, 'right', 'accompaniment', 0.8, 0.1),
];
const stats = noteStats(notes);
assert.equal(stats.melodyLeftShare, 1);
assert.equal(stats.melodyJumpRate, 1);
assert.equal(stats.melodyNotesPerSec, 1);
assert.equal(stats.pctUnder120ms, 20);
assert.equal(stats.accompanimentAttacksPerSec, 1.5);
assert.equal(stats.perHand.right.maxAccompanimentAttacksIn1s, 3);
assert.ok(Math.abs(stats.perHand.left.meanSounding - 0.9) < 1e-12);
assert.ok(Math.abs(stats.perHand.right.meanSounding - 0.55) < 1e-12);
// Union [0,.5] with [.2,.7] counts .7s once, divided by1.8s melody note-time.
assert.ok(Math.abs(stats.clashPct - 100 * 0.7 / 1.8) < 1e-10);
assert.equal(stats.melodyMetricSource, 'role');
assert.equal(noteStats([note(60, 'left', 'melody', 0, 1),
  note(85, 'right', 'accompaniment', 0, 1)]).clashPct, 0, 'exclude distances over14');
assert.equal(noteStats([note(60, 'left', 'melody', 0, 1),
  note(61, 'right', 'accompaniment', 1, 1)]).clashPct, 0, 'touching is not overlap');
assert.equal(stats.noBackingPct, null, 'No chord metadata cannot establish missing backing');
assert.equal(stats.longestNoBackingSeconds, null);
assert.equal(stats.vocalDecisionMedianPitch, null);
assert.equal(stats.vocalMelodyLeftShare, null);
assert.equal(stats.fallbackMelodyLeftShare, null);

// Used vocal assignment pitches can differ from detected native pitches after
// filtering and octave controls. Preserve the shared arrangement's metadata.
const sourceStats = noteStats(Object.assign([
  { ...note(46, 'left', 'melody', 0, 3), source: 'vocal' },
  { ...note(60, 'right', 'melody', 4, 1), source: 'vocal' },
  { ...note(72, 'right', 'melody', 6, 2), source: 'instrumental' },
], {
  vocalMedianPitch: 58, vocalDecisionMedianPitch: 46,
  vocalMelodyLeftShare: 0.75, fallbackMelodyLeftShare: 0,
}));
assert.equal(sourceStats.vocalMedianPitch, 58);
assert.equal(sourceStats.vocalDecisionMedianPitch, 46);
assert.equal(sourceStats.vocalMelodyLeftShare, 0.75);
assert.equal(sourceStats.fallbackMelodyLeftShare, 0, 'A zero left share is not absent metadata');
assert.equal(sourceStats.melodyLeftShare, 0.5);
const classicStats = noteStats([{ pitch: 60, hand: 'right', startTimeSeconds: 0,
  durationSeconds: 1, velocity: 0.8 }]);
assert.equal(classicStats.vocalDecisionMedianPitch, null);
assert.equal(classicStats.vocalMelodyLeftShare, null);
assert.equal(classicStats.fallbackMelodyLeftShare, null);

// Count actual uncovered chord time, including partial holes. Melody cannot
// fill accompaniment gaps; overlapping backing notes count only once.
const coverage = [
  note(72, 'right', 'melody', 0, 12),
  note(48, 'left', 'bass', 1, 2),
  note(55, 'left', 'accompaniment', 2, 2),
  note(52, 'left', 'accompaniment', 6, 1),
  note(48, 'left', 'bass', 9, 1),
];
coverage.chords = [
  { start: 0, end: 5, label: 'C', root: 0 },
  { start: 5, end: 8, label: 'N', root: null },
  { start: 8, end: 12, label: 'C', root: 0 },
];
const coverageStats = noteStats(coverage);
assert.ok(Math.abs(coverageStats.noBackingPct - 100 * 5 / 9) < 1e-10,
  'N time is excluded: five missing seconds across nine active chord seconds');
assert.equal(coverageStats.longestNoBackingSeconds, 2);
const offsetNotes = [note(48, 'left', 'bass', 0, 1), note(55, 'left', 'accompaniment', 2, 1)];
offsetNotes.chords = [{ start: 1, end: 5, label: 'C', root: 0 }];
offsetNotes.timingOffsetSeconds = 1;
assert.equal(noteStats(offsetNotes).noBackingPct, 50, 'Compare the shifted notes to shifted chord timestamps');
assert.equal(noteStats(offsetNotes).longestNoBackingSeconds, 1);
const missing = [];
missing.chords = [{ start: 0, end: 2, label: 'D5', root: 2 }];
assert.equal(noteStats(missing).noBackingPct, 100, 'An empty arrangement cannot pass the backing coverage metric');
assert.equal(noteStats(missing).longestNoBackingSeconds, 2);
missing.chords = [{ start: 0, end: 4, label: 'N', root: null }];
assert.equal(noteStats(missing).noBackingPct, 0);
assert.equal(noteStats(missing).longestNoBackingSeconds, 0);

const frames = Array.from({ length: 40 }, (_, i) =>
  Array.from({ length: 88 }, (_, p) => p === 39 && i >= 5 && i < 30 ? 0.7 : 0));
const weak = frames.map(row => row.map(() => 0));
assert.equal(extractNotes(frames, weak, { melodiaTrick: false }).length, 0);
assert.equal(extractNotes(frames, weak).length, 1);
const onsets = structuredClone(weak);
onsets[5][39] = 0.9;
const onsetOnly = extractNotes(frames, onsets, { melodiaTrick: false });
assert.ok(onsetOnly.length > 0);
assert.ok(onsetOnly.every(n => n.onset > 0));
console.log('role statistics and onset-only extraction tests passed');
