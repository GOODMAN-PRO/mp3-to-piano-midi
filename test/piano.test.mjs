import assert from 'node:assert/strict';
import midiPackage from '@tonejs/midi/build/Midi.js';
import { extractNotes } from '../extract.js';
import { toPianoNotes } from '../piano.js';
import { notesToMidi } from '../midi.js';
import { noteStats } from '../cli.mjs';

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

const withOnset = (pitch, start, duration, amplitude, onset) =>
  ({ ...note(pitch, start, duration, amplitude), onset });

const fragments = [
  withOnset(60, 0, 0.2, 0.3, 0.9),
  withOnset(60, 0.2, 0.2, 0.8, 0),
  withOnset(60, 0.47, 0.2, 0.5, 0.2),
];
const fragmentsOriginal = structuredClone(fragments);
assert.deepEqual(toPianoNotes(fragments, { legato: 0.5 }), [
  { pitch: 60, startTimeSeconds: 0, durationSeconds: 0.47 + 0.2, velocity: 0.8, onset: 0.9 },
]);
assert.deepEqual(fragments, fragmentsOriginal);
assert.equal(toPianoNotes(fragments, { legato: 0 }).length, 3);
// Disabling fragment smoothing still merges actual same-pitch overlaps.
assert.deepEqual(toPianoNotes(overlapping, { legato: 0 }), toPianoNotes(overlapping));

const first = withOnset(60, 0, 1, 0.5, 0.9);
assert.equal(toPianoNotes([first, withOnset(60, 1, 1, 0.5, 0.8)]).length, 2);
// A re-strike exactly at the onset threshold also stays separate.
assert.equal(toPianoNotes([first, withOnset(60, 1, 1, 0.5, 0.5)], { legato: 0.5 }).length, 2);
assert.equal(toPianoNotes([first, withOnset(60, 1.08, 1, 0.5, 0.1)]).length, 1);
assert.equal(toPianoNotes([first, withOnset(60, 1.08001, 1, 0.5, 0.1)]).length, 2);
assert.equal(toPianoNotes([first, withOnset(62, 1, 1, 0.5, 0.1)]).length, 2);
assert.equal(toPianoNotes([first, note(60, 1, 1)]).length, 2);
assert.equal(toPianoNotes([first, withOnset(60, 1, 1, 0.5, NaN)]).length, 2);
// Smoothing happens before chord selection, so the merged amplitude is considered.
assert.deepEqual(toPianoNotes([
  withOnset(60, 0, 0.5, 0.3, 0.8),
  withOnset(62, 0.01, 1, 0.8, 0.8),
  withOnset(60, 0.5, 0.5, 0.9, 0.1),
], { maxPoly: 1 }), [
  { pitch: 60, startTimeSeconds: 0, durationSeconds: 1, velocity: 0.9, onset: 0.8 },
]);

assert.deepEqual(extractNotes([], []), []);
const frames = Array.from({ length: 35 }, (_, i) =>
  Array.from({ length: 88 }, (_, pitch) => pitch === 39 && i >= 4 && i < 24 ? 0.7 : 0));
// A constant weak onset has no peaks. Melodia must report zero even when the raw model onset is nonzero.
const weakOnsets = frames.map(row => row.map((_, pitch) => pitch === 39 ? 0.1 : 0));
const extractionOriginal = structuredClone({ frames, weakOnsets });
const continuations = extractNotes(frames, weakOnsets, { energyTolerance: 1 });
assert.equal(continuations.length, 1);
assert.equal(continuations[0].pitchMidi, 60);
assert.equal(continuations[0].onset, 0);
assert.deepEqual({ frames, weakOnsets }, extractionOriginal);

const strongOnsets = frames.map(row => row.map(() => 0));
strongOnsets[8][39] = 0.9;
const onsetNotes = extractNotes(frames, strongOnsets, { energyTolerance: 1 });
assert.ok(onsetNotes.some(n => n.onset === 0.9 && n.startTimeSeconds === 8 * 256 / 22050));

// Eight frames must survive an eight-frame minimum; increasing it just past that boundary must remove them.
const shortFrames = Array.from({ length: 20 }, (_, i) =>
  Array.from({ length: 88 }, (_, pitch) => pitch === 39 && i >= 4 && i < 12 ? 0.7 : 0));
const shortOnsets = shortFrames.map(row => row.map(() => 0));
shortOnsets[4][39] = 0.9;
const boundary = extractNotes(shortFrames, shortOnsets, { minMs: 8 * 11.6099, energyTolerance: 1 });
assert.equal(boundary.length, 1);
assert.ok(Math.abs(boundary[0].durationSeconds - 8 * 256 / 22050) < 1e-12);
assert.deepEqual(extractNotes(shortFrames, shortOnsets, {
  minMs: 8 * 11.6099 + 0.001, energyTolerance: 1,
}), []);

const midiNotes = [
  { pitch: 59, startTimeSeconds: 0.005, durationSeconds: 0.1004, velocity: 0.7 },
  { pitch: 59, startTimeSeconds: 0.1054, durationSeconds: 0.1, velocity: 0.8 },
  { pitch: 60, startTimeSeconds: 0, durationSeconds: 0.5, velocity: 1 },
];
const bytes = notesToMidi(midiNotes);
assert.ok(bytes instanceof Uint8Array);
const midi = new midiPackage.Midi(bytes);
assert.equal(midi.header.tempos[0].bpm, 120);
assert.deepEqual(midi.tracks.map(track => track.name), ['Left hand', 'Right hand']);
assert.ok(midi.tracks.every(track => track.instrument.number === 0));
assert.equal(midi.tracks[0].notes.length, 2);
assert.equal(midi.tracks[0].notes[0].midi, 59);
assert.equal(midi.tracks[1].notes[0].midi, 60);
assert.equal(midi.tracks[0].notes[0].ticks + midi.tracks[0].notes[0].durationTicks,
  midi.tracks[0].notes[1].ticks);
const singleTrack = new midiPackage.Midi(notesToMidi(midiNotes, { splitHands: false }));
assert.equal(singleTrack.tracks.length, 1);
assert.equal(singleTrack.tracks[0].name, 'Piano');
assert.equal(singleTrack.tracks[0].notes.length, 3);

assert.deepEqual(noteStats([]), {
  notes: 0, seconds: 0, notesPerSec: 0, medianDurationMs: 0, pctUnder100ms: 0,
  fragments: 0, meanOnsetAtFragmentStart: 0, maxSoundingAtOnce: 0,
});
const measuredNotes = [
  { pitch: 60, startTimeSeconds: 0, durationSeconds: 0.08, onset: 0.9 },
  { pitch: 60, startTimeSeconds: 0.08, durationSeconds: 0.12, onset: 0.2 },
  { pitch: 60, startTimeSeconds: 0.25, durationSeconds: 0.2, onset: 0.4 },
  { pitch: 62, startTimeSeconds: 0.2, durationSeconds: 0.1, onset: 0.9 },
];
const stats = noteStats(measuredNotes);
assert.equal(stats.notes, 4);
assert.equal(stats.seconds, 0.45);
assert.equal(stats.notesPerSec, 4 / 0.45);
assert.equal(stats.medianDurationMs, 110);
assert.equal(noteStats(measuredNotes.slice(0, 3)).medianDurationMs, 120);
assert.equal(stats.pctUnder100ms, 25); // Exactly 100 ms is excluded.
assert.equal(stats.fragments, 2); // Touching notes and a 50 ms gap both count.
assert.ok(Math.abs(stats.meanOnsetAtFragmentStart - 0.3) < 1e-12); // Use each later note's onset.
assert.equal(stats.maxSoundingAtOnce, 2);
assert.equal(noteStats([
  { pitch: 60, startTimeSeconds: 0.1, durationSeconds: 0.2 },
  { pitch: 60, startTimeSeconds: 0.3, durationSeconds: 0.2 },
]).maxSoundingAtOnce, 1); // Floating-point endpoint noise must not create an overlap.

console.log('piano, extraction, MIDI, and statistics tests passed');
