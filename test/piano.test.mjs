import assert from 'node:assert/strict';
import { toPianoNotes } from '../piano.js';

const note = (pitchMidi, startTimeSeconds = 0, durationSeconds = 1, amplitude = 0.5) =>
  ({ pitchMidi, startTimeSeconds, durationSeconds, amplitude });

assert.equal(toPianoNotes([note(10)])[0].pitch, 22);
assert.equal(toPianoNotes([note(120)])[0].pitch, 108);

const overlapping = [note(60, 0, 2, 0.4), note(60, 1, 2, 0.8)];
const original = structuredClone(overlapping);
assert.deepEqual(toPianoNotes(overlapping), [
  { pitch: 60, startTimeSeconds: 0, durationSeconds: 3, velocity: 0.8 },
]);
assert.deepEqual(overlapping, original);

const chord = Array.from({ length: 8 }, (_, i) => note(60 + i, 0, 1, (i + 1) / 10));
assert.deepEqual(
  toPianoNotes(chord, { maxPoly: 6 }).map(n => n.pitch).sort((a, b) => a - b),
  [62, 63, 64, 65, 66, 67],
);
assert.equal(toPianoNotes([note(60, 0, 1, 2)])[0].velocity, 1);
assert.equal(toPianoNotes([note(60, 0, 1, 0)])[0].velocity, 0.05);
assert.equal(toPianoNotes([note(60, 0, 1), note(60, 1, 1)]).length, 2);
// 0.1 + 0.2 = 0.30000000000000004: back-to-back repeats must not merge on float noise.
assert.equal(toPianoNotes([note(60, 0.1, 0.2), note(60, 0.3, 0.2)]).length, 2);
assert.deepEqual(
  toPianoNotes([note(60, 0, 1, 0.2), note(62, 0.02, 1, 0.8), note(64, 0.04)], { maxPoly: 1 })
    .map(n => n.pitch),
  [62, 64],
);

console.log('piano tests passed');
