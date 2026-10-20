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
