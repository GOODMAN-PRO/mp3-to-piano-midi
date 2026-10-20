import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import midiPackage from '@tonejs/midi/build/Midi.js';
import { extractNotes } from '../extract.js';
import { estimateKey, estimateTempo, quantizeNotes, trackVoice, trackMelody, pianoDefaults, defaultMaxSounding,
  toPianoNotes as pianoWithLengthDefaults } from '../piano.js';
import { notesToMidi } from '../midi.js';
import { defaults, noteStats } from '../cli.mjs';

const note = (pitchMidi, startTimeSeconds = 0, durationSeconds = 1, amplitude = 0.5) =>
  ({ pitchMidi, startTimeSeconds, durationSeconds, amplitude });
// Keep the original processing assertions isolated from the new optional stages.
const pianoWithDefaults = (notes, options = {}) =>
  pianoWithLengthDefaults(notes, { preset: 'full', minSounding: 0, legatoGap: 0, maxSounding: 0, keyClean: 0, wobble: 0,
    melody: 0, quantize: false, ...options });
const toPianoNotes = (notes, options = {}) =>
  pianoWithDefaults(notes, { align: 0, dynamics: false, ghost: 0, ...options })
    .map(({ hand, ...note }) => note);

assert.equal(toPianoNotes([note(10)])[0].pitch, 22);
assert.equal(toPianoNotes([note(120)])[0].pitch, 108);

// Ignore invalid geometry, and use neutral amplitude when optional model fields are absent.
assert.equal(pianoWithLengthDefaults([
  null, note(NaN), note(Infinity), note(undefined), note(60, NaN), note(60, -1),
  note(60, 0, 0), note(60, 0, -1), note(60, 0, Infinity), note(60, 1e308, 1e308),
  note(60, 1e20, 0.1),
]).length, 0);
for (const pitch of [-1e100, 1e100, 60.4, 60.6]) {
  const folded = toPianoNotes([note(pitch)])[0].pitch;
  assert.ok(Number.isInteger(folded) && folded >= 21 && folded <= 108);
}
assert.equal(toPianoNotes([note(60.4)])[0].pitch, 60);
assert.equal(toPianoNotes([note(60.6)])[0].pitch, 61);
const missingFields = [
  { ...note(60, 0, 0.2), amplitude: undefined, onset: NaN },
  { ...note(60, 0.2, 0.2), amplitude: NaN, onset: undefined },
  { ...note(62, 2, 0.2), amplitude: Infinity, onset: Infinity },
];
const missingOriginal = structuredClone(missingFields);
const sanitized = toPianoNotes(missingFields);
assert.equal(sanitized.length, 3); // Unknown onset must not be mistaken for a weak continuation.
assert.ok(sanitized.every(n => n.amplitude === 0.5 && n.velocity === 0.5 && !Object.hasOwn(n, 'onset')));
assert.deepEqual(missingFields, missingOriginal);

const overlapping = [note(60, 0, 2, 0.4), note(60, 1, 2, 0.8)];
const original = structuredClone(overlapping);
assert.deepEqual(toPianoNotes(overlapping), [
  { pitch: 60, startTimeSeconds: 0, durationSeconds: 3, amplitude: 0.8, velocity: 0.8 },
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
  { pitch: 60, startTimeSeconds: 0, durationSeconds: 0.47 + 0.2, amplitude: 0.8, velocity: 0.8, onset: 0.9 },
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
  { pitch: 60, startTimeSeconds: 0, durationSeconds: 1, amplitude: 0.9, velocity: 0.9, onset: 0.8 },
]);

for (const interval of [12, 19, 24]) {
  assert.deepEqual(toPianoNotes([note(60, 1, 2, 1), note(60 + interval, 1, 1, 0.5)],
    { harmonic: 0.6 }).map(n => n.pitch), [60]);
}
const harmonicNotes = [note(60, 1, 2, 1), note(72, 1, 1, 0.5)];
const harmonicOriginal = structuredClone(harmonicNotes);
assert.equal(toPianoNotes(harmonicNotes, { harmonic: 0.6 }).length, 1);
assert.deepEqual(harmonicNotes, harmonicOriginal);
assert.equal(toPianoNotes(harmonicNotes, { harmonic: 0 }).length, 2);
assert.equal(toPianoNotes([note(60, 1, 2, 1), note(72, 1, 1, 0.95)], { harmonic: 0.6 }).length, 2);
assert.equal(toPianoNotes([note(60, 1, 2, 1), note(72, 1, 1, 0.6)], { harmonic: 0.6 }).length, 2);
// The candidate can start before or after its lower note, including the 30 ms boundary.
for (const offset of [-0.03, 0.03]) {
  assert.equal(toPianoNotes([note(60, 1, 2, 1), note(72, 1 + offset, 1, 0.5)],
    { harmonic: 0.6 }).length, 1);
}
assert.equal(toPianoNotes([note(60, 1, 2, 1), note(72, 1.03001, 1, 0.5)], { harmonic: 0.6 }).length, 2);
// Measure actual shared duration, not just the lower note's length.
assert.equal(toPianoNotes([note(60, 1, 0.61, 1), note(72, 1.03, 1, 0.5)], { harmonic: 0.6 }).length, 2);
assert.equal(toPianoNotes([note(60, 1.03, 0.6, 1), note(72, 1, 1, 0.5)], { harmonic: 0.6 }).length, 1);
assert.equal(toPianoNotes([note(60, 1, 1, 0.5), note(72, 1, 2, 1)], { harmonic: 0.6 }).length, 2);
// Cleanup frees a chord slot before the cap chooses the remaining notes.
assert.deepEqual(toPianoNotes([note(60, 0, 1, 1), note(72, 0, 1, 0.5), note(67, 0, 1, 0.4)],
  { harmonic: 0.6, maxPoly: 2 }).map(n => n.pitch), [60, 67]);
// Removing an early ghost must not move the original chord-group boundary.
assert.deepEqual(toPianoNotes([note(72, 0, 1, 0.3), note(60, 0.02, 2, 1), note(64, 0.04, 1, 0.8)],
  { harmonic: 0.6, maxPoly: 1 }).map(n => n.pitch), [60, 64]);

const smearedChord = [note(60, 1, 0.2), note(64, 1.02, 0.3), note(67, 1.04, 0.4)];
const smearedOriginal = structuredClone(smearedChord);
const alignedChord = pianoWithDefaults(smearedChord);
assert.deepEqual(alignedChord.map(n => n.startTimeSeconds), [1, 1, 1.04]);
for (let i = 0; i < alignedChord.length; i++) {
  assert.ok(Math.abs(alignedChord[i].startTimeSeconds + alignedChord[i].durationSeconds
    - (smearedChord[i].startTimeSeconds + smearedChord[i].durationSeconds)) < 1e-12);
}
assert.deepEqual(smearedChord, smearedOriginal);
assert.deepEqual(pianoWithDefaults(smearedChord, { align: 0 }).map(n => n.startTimeSeconds), [1, 1.02, 1.04]);
assert.deepEqual(pianoWithDefaults(smearedChord, { align: 10 }).map(n => n.startTimeSeconds), [1, 1.02, 1.04]);
// Very short repeats inside one chord window must not become simultaneous notes of the same pitch.
const fastRepeats = pianoWithDefaults([note(60, 0, 0.01), note(64, 0.005), note(60, 0.02, 0.1)]);
assert.deepEqual(fastRepeats.map(n => n.startTimeSeconds), [0, 0, 0.02]);
assert.equal(fastRepeats[0].durationSeconds, 0.01);
// A common chord start cannot overlap an earlier note of the same pitch.
const restrainedChord = pianoWithDefaults([note(60, 0, 1), note(60, 1, 0.5), note(64, 0.98, 0.5)]);
const previousC = restrainedChord.find(n => n.pitch === 60 && n.startTimeSeconds === 0);
const nextC = restrainedChord.find(n => n.pitch === 60 && n.startTimeSeconds === 1);
const chordE = restrainedChord.find(n => n.pitch === 64);
assert.equal(previousC.startTimeSeconds + previousC.durationSeconds, 1);
assert.equal(nextC.startTimeSeconds, chordE.startTimeSeconds);
assert.equal(nextC.startTimeSeconds + nextC.durationSeconds, 1.5);
assert.equal(chordE.startTimeSeconds + chordE.durationSeconds, 1.48);
const tinyChordNote = pianoWithDefaults([note(60, 0, 1), note(60, 1, 0.5), note(64, 0.98, 0.01)])
  .find(n => n.pitch === 64);
assert.ok(Math.abs(tinyChordNote.durationSeconds - 0.001) < 1e-12);

const amplitudeRange = Array.from({ length: 101 }, (_, i) => note(60, i * 2, 1, i / 100));
const dynamicNotes = pianoWithDefaults(amplitudeRange);
assert.ok(Math.abs(dynamicNotes[5].velocity - 0.35) < 1e-12);
assert.ok(Math.abs(dynamicNotes[50].velocity - 0.65) < 1e-12);
assert.ok(Math.abs(dynamicNotes[95].velocity - 0.95) < 1e-12);
assert.ok(dynamicNotes.every(n => n.velocity >= 0.1 && n.velocity <= 1));
assert.deepEqual(pianoWithDefaults([note(60), note(64)]).map(n => n.velocity), [0.7, 0.7]);
assert.deepEqual(pianoWithDefaults([note(60, 0, 1, 0), note(62, 2, 1, 0.5), note(64, 4, 1, 2)],
  { dynamics: false }).map(n => n.velocity), [0.05, 0.5, 1]);

const localDynamics = [
  note(60, 0, 0.1, 0.1), note(62, 0.2, 0.1, 0.8), note(64, 0.4, 0.2, 0.1),
  note(65, 0.6, 1, 0.8), note(67, 0.8, 1, 0.8),
  note(60, 10, 0.1, 0.1), note(62, 10.2, 0.1, 0.1), note(64, 10.4, 0.1, 0.1),
];
const cleanedDynamics = pianoWithDefaults(localDynamics, { ghost: 0.35 });
assert.deepEqual(cleanedDynamics.map(n => n.startTimeSeconds), [0.2, 0.4, 0.6, 0.8, 10, 10.2, 10.4]);
assert.equal(pianoWithDefaults(localDynamics, { ghost: 0 }).length, localDynamics.length);

// Choose the split from the conversion's pitch median, with a bounded register.
const separated = pitches => pitches.map((pitch, i) => note(pitch, i * 2));
assert.equal(pianoWithDefaults(separated([30, 36, 40])).splitPoint, 48);
assert.equal(pianoWithDefaults(separated([80, 84, 88])).splitPoint, 72);
assert.equal(pianoWithDefaults(separated([58, 61])).splitPoint, 59.5);
assert.equal(pianoWithDefaults([]).splitPoint, 60);
const fixedHands = pianoWithDefaults(separated([67, 72, 76]), { splitAt: 72 });
assert.equal(fixedHands.splitPoint, 72);
assert.deepEqual(fixedHands.map(n => n.hand), ['left', 'right', 'right']);
const fitsHands = notes => {
  for (const hand of ['left', 'right']) {
    const pitches = notes.filter(n => n.hand === hand).map(n => n.pitch);
    assert.ok(pitches.length <= 5);
    if (pitches.length) assert.ok(Math.max(...pitches) - Math.min(...pitches) <= 14);
  }
};
const twoOctaves = pianoWithDefaults([48, 52, 55, 60, 64, 67, 72].map(p => note(p)), { maxPoly: 7 });
assert.equal(twoOctaves.length, 7);
assert.equal(twoOctaves.playabilityDrops, 0);
assert.ok(twoOctaves.some(n => n.hand === 'left') && twoOctaves.some(n => n.hand === 'right'));
fitsHands(twoOctaves);
// A forced split is the preferred boundary; a feasible chord division still wins.
const shiftedBoundary = pianoWithDefaults([48, 50, 52, 54, 56, 58, 60].map(p => note(p)),
  { maxPoly: 7, splitAt: 72 });
assert.equal(shiftedBoundary.splitPoint, 72);
assert.equal(shiftedBoundary.length, 7);
assert.equal(shiftedBoundary.playabilityDrops, 0);
fitsHands(shiftedBoundary);
const impossibleChord = pianoWithDefaults([
  note(24, 0, 1, 0.9), note(60, 0, 1, 0.8), note(100, 0, 1, 0.1),
], { harmonic: 0 });
assert.deepEqual(impossibleChord.map(n => n.pitch), [24, 60]);
assert.equal(impossibleChord.playabilityDrops, 1);
fitsHands(impossibleChord);
// Assign hands before the total cap: retain quiet bass, drop the weakest of six upper notes.
const beforeTotalCap = pianoWithDefaults([
  note(48, 0, 1, 0.1), ...[72, 73, 74, 75, 76, 77].map((pitch, i) => note(pitch, 0, 1, 0.5 + i / 10)),
], { splitAt: 60, maxPoly: 6, harmonic: 0 });
assert.deepEqual(beforeTotalCap.map(n => n.pitch).sort((a, b) => a - b), [48, 73, 74, 75, 76, 77]);
assert.equal(beforeTotalCap.playabilityDrops, 1);
fitsHands(beforeTotalCap);
// Dropping an early cap candidate changes the final 30 ms group; reassign its hands.
const shiftedAnchor = pianoWithDefaults([
  note(36, 0, 0.3, 0.1), note(48, 0.02, 0.3, 0.8), note(24, 0.04, 0.3, 0.8),
], { align: 0, maxPoly: 1, splitAt: 60, harmonic: 0, ghost: 0, legato: 0 });
assert.deepEqual(shiftedAnchor.map(n => [n.pitch, n.hand]), [[48, 'right'], [24, 'left']]);
assert.equal(shiftedAnchor.playabilityDrops, 0);
assert.equal(noteStats(shiftedAnchor).handSpanViolations, 0);
assert.equal(noteStats(shiftedAnchor).handPolyViolations, 0);

const lengthNotes = (notes, options = {}) => pianoWithLengthDefaults(notes, {
  preset: 'full', legato: 0, harmonic: 0, align: 0, dynamics: false, ghost: 0, splitAt: 60,
  maxSounding: 0, keyClean: 0, wobble: 0, melody: 0, minSounding: 120,
  legatoGap: options.preset === 'easy' ? 150 : 100, quantize: false, ...options,
});
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12,
  `${actual} differs from ${expected}`);
const isolated = [note(60, 0, 0.08)];
const isolatedOriginal = structuredClone(isolated);
close(lengthNotes(isolated)[0].durationSeconds, 0.12);
assert.deepEqual(isolated, isolatedOriginal);
close(lengthNotes(isolated, { minSounding: 0 })[0].durationSeconds, 0.08);
// A nearby same-pitch successor is a re-strike, not an isolated flicker.
const closeRepeat = lengthNotes([note(60, 0, 0.2), note(60, 0.24, 0.2)]);
assert.equal(closeRepeat.length, 2);
close(closeRepeat[0].durationSeconds, 0.239);
close(closeRepeat[1].startTimeSeconds - closeRepeat[0].durationSeconds, 0.001);
const spacedRepeatInput = [note(60, 0, 0.2), note(60, 0.28, 0.2)];
const spacedRepeat = lengthNotes(spacedRepeatInput);
close(spacedRepeat[0].durationSeconds, 0.2);
assert.equal(noteStats(spacedRepeat).fragments, 0);
// Longer custom normalization must not create a <=50 ms fragment either.
close(lengthNotes([note(60, 0, 0.08), note(60, 0.5, 0.2)],
  { minSounding: 600, legatoGap: 0 })[0].durationSeconds, 0.08);
const joinedLineInput = [note(60, 0, 0.2), note(62, 0.28, 0.2)];
const joinedLineOriginal = structuredClone(joinedLineInput);
const joinedLine = lengthNotes(joinedLineInput);
close(joinedLine[0].durationSeconds, 0.28);
assert.deepEqual(joinedLine.map(n => n.startTimeSeconds), [0, 0.28]);
assert.deepEqual(joinedLineInput, joinedLineOriginal);
close(lengthNotes(joinedLineInput, { legatoGap: 0 })[0].durationSeconds, 0.2);
close(lengthNotes([note(60, 0, 0.2), note(62, 0.32, 0.2)])[0].durationSeconds, 0.2);
// A larger custom gap still adds at most 150 ms to one note.
close(lengthNotes([note(60, 0, 0.2), note(62, 0.6, 0.2)],
  { legatoGap: 500 })[0].durationSeconds, 0.35);
// Gap-fill follows the hand label, even for a note on the same side of middle C.
close(lengthNotes([note(60, 0, 0.2), note(62, 0.28, 0.2)],
  { splitAt: 62 })[0].durationSeconds, 0.2);
const heldChord = lengthNotes([note(60, 0, 0.2), note(64, 0, 0.2), note(67, 0.28, 0.3)]);
assert.deepEqual(heldChord.slice(0, 2).map(n => n.durationSeconds), [0.2, 0.2]);
const disabledLengths = lengthNotes([note(60, 0, 0.08), note(62, 0.16, 0.2)],
  { minSounding: 0, legatoGap: 0 });
close(disabledLengths[0].durationSeconds, 0.08);
close(disabledLengths[1].durationSeconds, 0.2);

// Preserve a quiet melody and bass before the loudness cap chooses inner voices.
const easyChordInput = [48, 52, 55, 60, 64, 67, 72]
  .map(pitch => note(pitch, 0, 0.2, pitch === 48 || pitch === 72 ? 0.1 : 0.8));
const easyChordOriginal = structuredClone(easyChordInput);
const easyChord = lengthNotes(easyChordInput, { preset: 'easy', maxPoly: 2 });
assert.deepEqual(easyChord.map(n => [n.pitch, n.hand]), [[48, 'left'], [72, 'right']]);
assert.deepEqual(easyChordInput, easyChordOriginal);
const easyShort = lengthNotes([note(48, 0, 0.2), note(60, 0, 0.2), note(67, 0, 0.08)],
  { preset: 'easy' });
assert.deepEqual(easyShort.map(n => n.pitch), [48]); // Drop the short melody before normalization.
close(lengthNotes([note(60, 0, 0.2), note(62, 0.32, 0.2)],
  { preset: 'easy' })[0].durationSeconds, 0.32);
close(lengthNotes([note(60, 0, 0.2), note(62, 0.32, 0.2)],
  { preset: 'easy', legatoGap: 0 })[0].durationSeconds, 0.2);
const easyMovedAnchor = lengthNotes([note(60, 0, 0.08), note(64, 0.02, 0.2), note(67, 0.04, 0.2)],
  { preset: 'easy' });
assert.deepEqual(easyMovedAnchor.map(n => n.pitch), [67]);
for (const pitch of [40, 80]) {
  const oneHand = lengthNotes(Array.from({ length: 20 }, (_, i) => note(pitch, 3600 + i, 0.2)),
    { preset: 'easy' });
  assert.equal(oneHand.length, 20);
  assert.ok(oneHand.every(n => n.hand === (pitch < 60 ? 'left' : 'right') && n.durationSeconds > 0));
}
const tinyAligned = pianoWithDefaults([
  withOnset(60, 0, 0.0002, 0.8, 0.9), withOnset(64, 0.0001, 0.1, 0.8, 0.9),
  withOnset(60, 0.0003, 0.1, 0.8, 0.9),
]);
const tinyCs = tinyAligned.filter(n => n.pitch === 60);
assert.ok(tinyAligned.every(n => n.durationSeconds > 0));
assert.ok(tinyCs[0].startTimeSeconds + tinyCs[0].durationSeconds <= tinyCs[1].startTimeSeconds);

const coherenceNotes = (notes, options = {}) => lengthNotes(notes, {
  minSounding: 0, legatoGap: 0, maxPoly: 10, ...options,
});
// Release sustained notes without dropping attacks; a new hand gets first choice of its fingers.
const capInput = [note(48, 0, 1, 0.9), note(60, 0.1, 1, 0.1), note(64, 0.2, 0.2, 0.8)];
const capOriginal = structuredClone(capInput);
const capped = coherenceNotes(capInput, { maxSounding: 2 });
assert.equal(capped.length, 3);
close(capped.find(n => n.pitch === 48).durationSeconds, 1);
close(capped.find(n => n.pitch === 60).durationSeconds, 0.099);
assert.equal(noteStats(capped).maxSoundingAtOnce, 2);
assert.deepEqual(capInput, capOriginal);
assert.equal(coherenceNotes(capInput, { maxSounding: 0 })[1].durationSeconds, 1);
const oldestFirst = coherenceNotes([note(60, 0, 1, 0.9), note(62, 0.1, 1, 0.1), note(64, 0.2, 1)],
  { maxSounding: 2 });
close(oldestFirst[0].durationSeconds, 0.199);
close(oldestFirst[1].durationSeconds, 1);
const quietTie = coherenceNotes([note(60, 0, 1, 0.9), note(64, 0, 1, 0.1), note(67, 0.2, 1)],
  { maxSounding: 2 });
close(quietTie.find(n => n.pitch === 60).durationSeconds, 1);
close(quietTie.find(n => n.pitch === 64).durationSeconds, 0.199);
const protectedShort = coherenceNotes([note(60, 0, 0.5), note(62, 0.04, 0.5)], { maxSounding: 1 });
close(protectedShort[0].durationSeconds, 0.5);
assert.equal(noteStats(protectedShort).maxSoundingAtOnce, 2); // The 60 ms floor takes priority over the cap.
close(coherenceNotes([note(60, 0, 0.5), note(62, 0.061, 0.5)],
  { maxSounding: 1 })[0].durationSeconds, 0.06);
// Finger release is allowed to shorten a normalized note, while preserving its separate 60 ms floor.
close(coherenceNotes([note(60, 0, 1), note(62, 0.08, 1)],
  { maxSounding: 1, minSounding: 100 })[0].durationSeconds, 0.079);
close(coherenceNotes([note(60, 0, 1), note(62, 0.12, 1)],
  { maxSounding: 1, minSounding: 100 })[0].durationSeconds, 0.119);
const overCapChord = coherenceNotes([60, 64, 67].map(pitch => note(pitch, 0, 0.2)), { maxSounding: 1 });
assert.equal(overCapChord.length, 3);
assert.ok(overCapChord.every(n => n.durationSeconds === 0.2));

// A global key is only a hint: keep strong chromatic notes, long chromatic notes, and a quiet passage.
const keyInput = [
  ...[60, 62, 64, 65, 67, 69, 71].map((pitch, i) => note(pitch, i * 0.05,
    [6.35, 3.48, 4.38, 4.09, 5.19, 3.66, 2.88][i], 1)),
  note(61, 0.4, 0.15, 0.1), note(63, 0.6, 0.25, 0.1),
  note(66, 0.8, 0.15, 0.6), note(68, 0.95, 0.15, 0.8),
  note(61, 10, 0.1, 0.1), note(63, 10.2, 0.1, 0.1), note(66, 10.4, 0.1, 0.1),
];
const keyOriginal = structuredClone(keyInput);
assert.equal(estimateKey(keyInput).name, 'C major');
const keyCleaned = coherenceNotes(keyInput, { keyClean: 0.6 });
assert.deepEqual(keyCleaned.map(n => n.startTimeSeconds), keyInput.filter(n => n.startTimeSeconds !== 0.4)
  .map(n => n.startTimeSeconds));
assert.equal(coherenceNotes(keyInput, { keyClean: 0 }).length, keyInput.length);
assert.deepEqual(keyInput, keyOriginal);

const wobbleInput = [note(60, 0, 0.08), note(61, 0.1, 0.04), note(60, 0.2, 0.08)];
const wobbleOriginal = structuredClone(wobbleInput);
const wobbleMerged = coherenceNotes(wobbleInput, { wobble: 150 });
assert.equal(wobbleMerged.length, 1);
assert.equal(wobbleMerged[0].pitch, 60);
close(wobbleMerged[0].startTimeSeconds, 0);
close(wobbleMerged[0].durationSeconds, 0.28);
assert.equal(noteStats(wobbleMerged).wobblePairs, 0);
assert.deepEqual(wobbleInput, wobbleOriginal);
assert.equal(coherenceNotes(wobbleInput, { wobble: 0 }).length, 3);
const middleWins = coherenceNotes([note(60, 0, 0.04), note(61, 0.1, 0.2), note(60, 0.2, 0.04)],
  { wobble: 150 });
assert.equal(middleWins.length, 1);
assert.equal(middleWins[0].pitch, 61);
close(middleWins[0].startTimeSeconds, 0);
close(middleWins[0].durationSeconds, 0.3);
assert.equal(coherenceNotes([note(60, 0, 0.08), note(61, 0.16, 0.04), note(60, 0.32, 0.08)],
  { wobble: 150 }).length, 3);
assert.equal(coherenceNotes([note(60, 0, 0.08), note(61, 0.1, 0.04), note(62, 0.2, 0.08)],
  { wobble: 150 }).length, 3);
assert.equal(coherenceNotes([...wobbleInput, note(65, 0.1, 0.04)], { wobble: 150 }).length, 4);
assert.equal(coherenceNotes(wobbleInput, { wobble: 150, splitAt: 61 }).length, 3);
// Do not erase an individually longer middle note merely because two shorter repeats add up to more time.
assert.equal(coherenceNotes([note(60, 0, 0.08), note(61, 0.1, 0.12), note(60, 0.2, 0.08)],
  { wobble: 150 }).length, 3);

// Voice selection considers the whole phrase, rather than taking each group's highest pitch.
const voiceNote = (pitch, startTimeSeconds, amplitude = 1, durationSeconds = 0.2) =>
  ({ pitch, startTimeSeconds, durationSeconds, amplitude });
const voiceGroups = [[voiceNote(60, 0)], [voiceNote(62, 0.5), voiceNote(84, 0.5)], [voiceNote(64, 1)]];
const voiceOriginal = structuredClone(voiceGroups);
const voice = trackVoice(voiceGroups);
assert.deepEqual(voice.map(n => n.pitch), [60, 62, 64]);
assert.equal(voice[1], voiceGroups[1][0]);
assert.deepEqual(voiceGroups, voiceOriginal);
assert.deepEqual(trackVoice([[], ...voiceGroups, []]), voice);
assert.deepEqual(trackVoice([]), []);
// A future phrase resolves the first ambiguous chord; a greedy tracker would pick the louder low note.
assert.deepEqual(trackVoice([
  [voiceNote(60, 0, 1), voiceNote(72, 0, 0.9)], [voiceNote(72, 0.5)], [voiceNote(72, 1)],
]).map(n => n.pitch), [72, 72, 72]);
assert.deepEqual(trackVoice([[voiceNote(60, 0), voiceNote(72, 0)]]).map(n => n.pitch), [72]);
assert.deepEqual(trackVoice([[voiceNote(48, 0), voiceNote(60, 0)]],
  { intervalWeight: 0.04, preferHigher: false }).map(n => n.pitch), [48]);
// Leaving a gap longer than one second carries the requested extra half-point cost.
assert.deepEqual(trackVoice([
  [voiceNote(60, 0, 1, 0.1), voiceNote(62, 0, 0.7, 1.5)], [voiceNote(62, 2)],
]).map(n => n.pitch), [62, 62]);
assert.deepEqual(trackVoice(voiceGroups.map(group => group.map(n => ({ ...n, amplitude: n.amplitude * 0.2 }))))
  .map(n => n.pitch), voice.map(n => n.pitch));

// A melody gap may contain accompaniment: resting is better than inserting a two-octave detour.
const restingGroups = [[voiceNote(60, 0)], [voiceNote(84, 0.5)], [voiceNote(60, 1)]];
const restingOriginal = structuredClone(restingGroups);
assert.deepEqual(trackMelody(restingGroups).map(n => n.pitch), [60, 60]);
assert.deepEqual(trackVoice(restingGroups).map(n => n.pitch), [60, 84, 60]); // Bass remains forced.
assert.equal(trackMelody(restingGroups)[1], restingGroups[2][0]);
assert.deepEqual(restingGroups, restingOriginal);
assert.deepEqual(trackMelody([]), []);
assert.deepEqual(trackMelody([[], []]), []);
assert.deepEqual(trackMelody([[], ...voiceGroups, []]).map(n => n.pitch), [60, 62, 64]);
// Exercise the arrangement call sites too: the optional tracker must actually be wired in.
for (const preset of ['easy', 'cover']) {
  const phrase = coherenceNotes([
    note(60, 0, 0.2, 1), note(84, 0.5, 0.2, 1), note(60, 1, 0.2, 1),
  ], { preset, melody: 3 });
  assert.deepEqual(phrase.filter(n => n.hand === 'right').map(n => n.pitch), [60, 60],
    `${preset} must rest through the accompaniment detour`);
  assert.ok(!phrase.some(n => n.startTimeSeconds > 0.2 && n.startTimeSeconds < 1));
}
// Exhaust all 36 choices on a tiny phrase, including rests; check the objective independently of the DP.
const optionalGroups = [
  [voiceNote(60, 0, 1), voiceNote(72, 0, 0.9, 1.5)], [voiceNote(84, 0.5, 0.8)], [],
  [voiceNote(62, 2, 0.7), voiceNote(74, 2, 1)], [voiceNote(60, 2.5, 0.9)],
];
const possibleLines = optionalGroups.reduce((lines, group) =>
  lines.flatMap(line => [line, ...group.map(n => [...line, n])]), [[]]);
const melodyCost = line => {
  let cost = (optionalGroups.length - line.length) * 0.5;
  for (let i = 0; i < line.length; i++) {
    cost -= line[i].amplitude;
    if (i) cost += 0.08 * Math.abs(line[i].pitch - line[i - 1].pitch) +
      (line[i].startTimeSeconds - line[i - 1].startTimeSeconds - line[i - 1].durationSeconds > 1 ? 0.5 : 0);
  }
  return cost;
};
close(melodyCost(trackMelody(optionalGroups)), Math.min(...possibleLines.map(melodyCost)));
// A modest skip-cost increase would turn these brief accompaniment pickups into repeated leaps.
const multiplePhrases = Array.from({ length: 12 }, (_, phrase) => [
  note(60, phrase * 0.6, 0.16, 1),
  note(69, phrase * 0.6 + 0.2, 0.16, 0.89),
  note(60, phrase * 0.6 + 0.4, 0.16, 1),
]).flat();
for (const preset of ['easy', 'cover']) {
  const line = coherenceNotes(multiplePhrases, { preset, melody: 3 });
  assert.ok(noteStats(line).melodyJumpRate <= 0.15, `${preset} must keep the phrase's continuity margin`);
  assert.equal(line.filter(n => n.hand === 'right').length, 24);
}

const melodyInput = [note(60, 0, 0.2), note(62, 1, 0.2), note(74, 1, 0.2)];
const melodic = coherenceNotes(melodyInput, { preset: 'easy', melody: 3 });
assert.deepEqual(melodic.map(n => n.pitch), [60, 62]);
assert.deepEqual(coherenceNotes(melodyInput, { preset: 'easy', melody: 0 }).map(n => n.pitch), [60, 74]);
assert.deepEqual(coherenceNotes(melodyInput, { preset: 'full', melody: 3 }).map(n => n.pitch), [60, 62, 74]);
assert.equal(noteStats(melodic).melodyJumpRate, 0);
const nearbyRepeat = [note(60, 0, 0.2), note(62, 0.7, 0.2), note(62, 0.94, 0.2), note(74, 0.94, 0.2)];
assert.deepEqual(coherenceNotes(nearbyRepeat, { preset: 'easy', melody: 3 }).map(n => n.pitch), [60, 62, 62]);
const futureRepeat = [...melodyInput, note(62, 1.24, 0.2)];
assert.deepEqual(coherenceNotes(futureRepeat, { preset: 'easy', melody: 3 }).map(n => n.pitch), [60, 62, 62]);
for (const input of [nearbyRepeat, futureRepeat]) {
  assert.ok(noteStats(coherenceNotes(input, { preset: 'easy', melody: 3 })).fragments
    <= noteStats(coherenceNotes(input, { preset: 'full' })).fragments);
}
assert.deepEqual(coherenceNotes(melodyInput, { preset: 'easy', melody: 3 }), melodic);

// Cover gives chord tones to strong chord changes, and excludes chromatic inner voices.
const coverInput = Array.from({ length: 5 }, (_, i) => [48, 52, 55, 58, 72]
  .map(pitch => note(pitch, i * 2, pitch === 58 ? 0.15 : 1, (i + 1) / 5))).flat();
const coverOriginal = structuredClone(coverInput);
assert.equal(estimateKey(coverInput).name, 'C major');
const coverNotes = coherenceNotes(coverInput, { preset: 'cover', melody: 3 });
for (let group = 0; group < 5; group++) {
  const sounding = coverNotes.filter(n => n.startTimeSeconds === group * 2);
  assert.deepEqual(sounding.filter(n => n.hand === 'right').map(n => n.pitch), [72]);
  assert.deepEqual(sounding.filter(n => n.hand === 'left').map(n => n.pitch),
    group === 3 ? [48, 52, 55] : [48]); // The final group repeats the same pitch-class set.
  fitsHands(sounding);
}
assert.deepEqual(coverInput, coverOriginal);
assert.ok(coverNotes.every(n => n.pitch !== 58));
for (const pitch of [48, 72]) {
  const oneHandCover = coherenceNotes([note(pitch, 0, 0.2), note(pitch, 2, 0.2)],
    { preset: 'cover', melody: 3 });
  assert.equal(oneHandCover.length, 2);
  assert.ok(oneHandCover.every(n => n.hand === (pitch === 48 ? 'left' : 'right')));
}
assert.equal(coherenceNotes([], { preset: 'cover' }).length, 0);
// A lone tune may cross the adaptive hand split. Its low notes are still the tune,
// even when two of them share a bass beat bucket. Rounded note-list repro needs no inference.
const crossingSplitLine = [
  [60, 0.0232, 0.8940, 0.5752, 0.6313], [62, 0.9985, 0.9404, 0.5771, 0.6813],
  [64, 1.9982, 0.9288, 0.5632, 0.6504], [65, 3.0083, 0.9288, 0.5554, 0.3559],
  [67, 3.9964, 0.9520, 0.5594, 0.5975], [65, 5.0065, 0.9288, 0.5536, 0.6547],
  [64, 5.9946, 0.9404, 0.5571, 0.6350], [62, 7.0047, 0.9288, 0.5688, 0.6085],
  [60, 7.9928, 0.9404, 0.5718, 0.6777], [64, 8.9913, 0.9417, 0.5522, 0.7239],
  [67, 9.9910, 0.9404, 0.5594, 0.7521], [72, 11.0011, 0.9172, 0.5736, 0.5098],
].map(args => withOnset(...args));
const crossingSplitOriginal = structuredClone(crossingSplitLine);
for (const preset of ['cover', 'easy']) for (const quantize of [true, false]) {
  const arranged = pianoWithLengthDefaults(crossingSplitLine, { preset, quantize });
  assert.equal(arranged.splitPoint, 64);
  assert.equal(arranged.quantized, quantize);
  assert.deepEqual(arranged.map(n => n.pitch), crossingSplitLine.map(n => n.pitchMidi),
    `${preset} must retain every attack of a lone line crossing the split`);
  assert.equal(arranged.filter(n => n.hand === 'left').length, 4);
}
assert.deepEqual(crossingSplitLine, crossingSplitOriginal);
// The same guarantee applies without an accepted tempo, including a stronger bass-bucket rival.
const quickLoneLine = [60, 62, 64, 65, 67, 65, 64, 62, 60, 64, 67, 72]
  .map((pitch, i) => withOnset(pitch, i * 0.22, 0.16, i === 1 ? 1 : 0.6, 1));
for (const preset of ['cover', 'easy']) {
  assert.deepEqual(pianoWithLengthDefaults(quickLoneLine, { preset }).map(n => n.pitch),
    quickLoneLine.map(n => n.pitchMidi));
  const shortLone = coherenceNotes([note(48, 0, 0.08), note(72, 1, 0.2)],
    { preset, melody: 3 });
  assert.deepEqual(shortLone.map(n => n.pitch), [48, 72], 'Easy must not erase a short lone-line attack');
  const heldLoneClass = coherenceNotes([note(48, 0, 1), note(60, 0.4, 0.2)],
    { preset, splitAt: 72, melody: 3 });
  assert.deepEqual(heldLoneClass.map(n => n.pitch), [48, 60],
    'a lone line is exempt from the still-sounding bass pitch-class rule');
}
// A real bass under a held melody remains left-handed and remains eligible for thinning.
const accompaniedBass = [0, 1].flatMap((start, i) => [
  note(72 + i * 2, start, 0.8, 1),
  note(48 + i * 4, start + 0.05, 0.16, 0.4),
  note(50 + i * 3, start + 0.15, 0.3, 1),
]);
for (const preset of ['cover', 'easy']) {
  const arranged = coherenceNotes(accompaniedBass, { preset, splitAt: 60, melody: 3 });
  assert.deepEqual(arranged.filter(n => n.hand === 'right').map(n => n.pitch), [72, 74]);
  assert.ok(arranged.filter(n => n.pitch < 60).every(n => n.hand === 'left'),
    'bass notes sounding under a real melody must not be promoted to the melody hand');
  assert.deepEqual(arranged.filter(n => n.hand === 'left').map(n => n.pitch),
    preset === 'cover' ? [50, 53] : [48, 50, 52, 53],
    'a held melody must prevent the lone-line exemption from bypassing bass thinning');
}
const prunedChord = coherenceNotes([
  note(48, 0, 0.15, 0.4), note(52, 0.02, 0.15, 0.6),
  note(72, 0.1, 1, 1), note(50, 0.2, 0.3, 1),
], { preset: 'cover', splitAt: 60, maxPoly: 1, melody: 3 });
assert.deepEqual(prunedChord.map(n => n.pitch), [72, 50],
  'a chord member must not gain lone-line protection when a previous selection removes its partner');
const discardedRight = coherenceNotes([
  note(72, 0, 0.1), note(48, 0.04, 0.08), note(74, 1, 0.2),
], { preset: 'easy', splitAt: 60, melody: 3 });
assert.deepEqual(discardedRight.map(n => n.pitch), [48, 74],
  'a right-hand note that Easy discards must not hide the remaining lone left-hand attack');
const changedMelody = coherenceNotes([
  note(60, 0, 0.2, 1), note(48, 0.07, 0.08, 1),
  note(70, 0.5, 0.1, 1), note(80, 1, 0.2, 1),
], { preset: 'easy', splitAt: 60, melody: 3 });
assert.deepEqual(changedMelody.map(n => n.pitch), [48, 80],
  'lone-line protection must use the final melody after Easy removes a short bridging note');
// Without an accepted grid Cover allows one bass attack per 300 ms, without thinning the melody.
const busyBass = [0, 0.1, 0.31, 0.4].flatMap((start, i) => [
  note([48, 50, 52, 53][i], start, 0.2), note([72, 74, 76, 77][i], start, 0.2),
]);
const sparseCover = coherenceNotes(busyBass, { preset: 'cover', melody: 3 });
const busyEasy = coherenceNotes(busyBass, { preset: 'easy', melody: 3 });
assert.deepEqual(sparseCover.filter(n => n.hand === 'left').map(n => n.pitch), [48, 52]);
assert.deepEqual(sparseCover.filter(n => n.hand === 'right'), busyEasy.filter(n => n.hand === 'right'));
assert.ok(noteStats(sparseCover).notesPerSec < noteStats(busyEasy).notesPerSec);
assert.ok(noteStats(sparseCover).meanSounding < noteStats(busyEasy).meanSounding);
const heldBassClass = coherenceNotes([
  note(48, 0, 1), note(80, 0, 0.2), note(60, 0.4, 0.2), note(82, 0.4, 0.2),
], { preset: 'cover', splitAt: 72, melody: 3 });
assert.deepEqual(heldBassClass.filter(n => n.hand === 'left').map(n => n.pitch), [48]);
assert.deepEqual(heldBassClass.filter(n => n.hand === 'right').map(n => n.pitch), [80, 82]);
const thinnedLegato = coherenceNotes([...coverInput, note(50, 9.08, 0.2, 0.1)], {
  preset: 'cover', melody: 3, legatoGap: 100,
});
close(thinnedLegato.find(n => n.pitch === 48 && n.startTimeSeconds === 8).durationSeconds, 1.08);

const clicks100 = Array.from({ length: 40 }, (_, i) => ({
  ...voiceNote(60, 0.037 + i * 0.6, 1, 0.1), onset: 1,
}));
const clickTempo = estimateTempo(clicks100);
assert.ok(Math.abs(clickTempo.estimatedBpm - 100) < 0.1);
assert.ok(clickTempo.tempoConfidence > 0.9);
assert.ok(Math.abs(clickTempo.gridPhaseSeconds - 0.037) < 0.005);
assert.ok(clickTempo.gridDeviationMs < 1);
assert.equal(clickTempo.eligible, true);
assert.deepEqual(estimateTempo([]), estimateTempo([null]));
for (const shortNotes of [clicks100.slice(0, 10), clicks100.slice(0, 10)
  .map(n => ({ ...n, startTimeSeconds: n.startTimeSeconds + 3600 }))]) {
  const shortTempo = estimateTempo(shortNotes);
  assert.equal(shortTempo.estimatedBpm, 120);
  assert.equal(shortTempo.eligible, false);
}
let randomState = 123;
const irregularOnsets = Array.from({ length: 100 }, () => {
  randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
  return { ...voiceNote(60, randomState / 2 ** 32 * 30, 1, 0.1), onset: 1 };
}).sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);
const uncertainTempo = estimateTempo(irregularOnsets);
assert.equal(uncertainTempo.estimatedBpm, 120);
assert.equal(uncertainTempo.eligible, false);
assert.ok(uncertainTempo.tempoConfidence < 0.12);
// An enormous timestamp/span must fail closed, rather than allocate a giant onset curve.
assert.equal(estimateTempo([voiceNote(60, 0, 1, 1e20)]).eligible, false);

// A weak alternate-beat onset pattern fooled autocorrelation into choosing 65 BPM.
// Its sixteenth-note phase is substantially more concentrated at the true 130 BPM octave.
const octaveWeights = [1, 0.3, 0, 0, 0.1, 0.3, 0, 0];
const octavePattern = Array.from({ length: 256 }, (_, i) => ({
  startTimeSeconds: i * 60 / 130 / 4, durationSeconds: 0.08,
  amplitude: octaveWeights[i % 8], onset: 1,
})).filter(n => n.amplitude);
const octaveTempo = estimateTempo(octavePattern);
assert.equal(octaveTempo.eligible, true);
assert.ok(Math.abs(octaveTempo.estimatedBpm - 130) < 0.1);
assert.ok(octaveTempo.phaseConfidence > 0.99);
// These ratios bracket the octave gate, rather than merely testing an overwhelming advantage.
const phaseConcentration = (notes, bpm) => {
  let real = 0, imaginary = 0, total = 0;
  for (const n of notes) {
    const angle = 2 * Math.PI * n.startTimeSeconds / (60 / bpm / 4);
    real += n.amplitude * Math.cos(angle);
    imaginary += n.amplitude * Math.sin(angle);
    total += n.amplitude;
  }
  return Math.hypot(real, imaginary) / total;
};
for (const [weakBeat, lowRatio, highRatio, expectedBpm] of [
  [0.06, 1.2, 1.3, 65], [0.10, 1.4, 1.5, 65],
  [0.14, 1.6, 1.7, 130], [0.16, 1.7, 2.0, 130],
]) {
  const weights = [1, weakBeat, 0, 0, 0.1, weakBeat, 0, 0];
  const pattern = Array.from({ length: 256 }, (_, i) => ({
    ...voiceNote(60, i * 60 / 130 / 4, weights[i % 8], 0.08), onset: 1,
  })).filter(n => n.amplitude);
  const ratio = phaseConcentration(pattern, 130) / phaseConcentration(pattern, 65);
  assert.ok(ratio > lowRatio && ratio < highRatio, `phase ratio ${ratio}`);
  const timing = estimateTempo(pattern);
  assert.equal(timing.eligible, true);
  assert.ok(Math.abs(timing.estimatedBpm - expectedBpm) < 0.1,
    `phase ratio ${ratio.toFixed(3)} should choose ${expectedBpm} BPM`);
}

const internalNote = (pitch, startTimeSeconds, end, hand = 'right') =>
  ({ pitch, startTimeSeconds, end, hand, amplitude: 0.8 });
const exactGrid = { ...clickTempo, estimatedBpm: 100, gridPhaseSeconds: 0.037 };
const offGrid = [internalNote(60, 1.002, 1.25), internalNote(64, 1.512, 1.7)];
const offGridOriginal = structuredClone(offGrid);
const snapped = quantizeNotes(offGrid, exactGrid);
assert.equal(snapped.estimatedBpm, 100);
assert.equal(snapped.quantized, true);
close(snapped.timingOffsetSeconds, 0.037);
assert.equal(snapped.notes.length, offGrid.length);
for (const n of snapped.notes) {
  close(n.startTimeSeconds / 0.15, Math.round(n.startTimeSeconds / 0.15));
  close(n.end / 0.15, Math.round(n.end / 0.15));
  assert.ok(n.end - n.startTimeSeconds >= 0.15 - 1e-12);
}
assert.deepEqual(offGrid, offGridOriginal);
for (const guarded of [quantizeNotes(offGrid, exactGrid, { enabled: false }),
  quantizeNotes(offGrid, uncertainTempo), quantizeNotes(offGrid, estimateTempo(clicks100.slice(0, 10)))]) {
  assert.deepEqual(guarded.notes, offGrid);
  assert.equal(guarded.estimatedBpm, 120);
  assert.equal(guarded.quantized, false);
}
const fromInternal = notes => notes.map(({ end, ...n }) => ({ ...n, durationSeconds: end - n.startTimeSeconds }));
const gridWithoutPhase = { ...exactGrid, gridPhaseSeconds: 0 };
// Protect the entire attack when one re-strike cannot snap, so its chord partners cannot become flams.
const reStrikeChord = [
  internalNote(60, 9.9, 10.02),
  ...[60, 64, 67].map(pitch => internalNote(pitch, 10.09, 10.39)),
];
const protectedChord = quantizeNotes(reStrikeChord, gridWithoutPhase);
assert.deepEqual(protectedChord.notes.slice(1).map(n => n.startTimeSeconds), [10.09, 10.09, 10.09]);
// Reverting a re-strike must not move it ahead of an originally earlier attack in the same hand.
const attackOrder = [
  internalNote(60, 0.08, 0.28), internalNote(64, 0.12, 0.16), internalNote(64, 0.19, 0.31),
];
const orderedGrid = quantizeNotes(attackOrder, gridWithoutPhase);
assert.deepEqual(orderedGrid.notes.map(n => n.pitch), [60, 64, 64]);
assert.deepEqual(orderedGrid.notes.map(n => n.startTimeSeconds), [0.08, 0.12, 0.19]);
for (const repeated of [
  [internalNote(60, 0.02, 0.06), internalNote(60, 0.08, 0.12)],
  [internalNote(60, 0, 0.1), internalNote(60, 0.22, 0.3)],
  [internalNote(60, 0, 0.4), internalNote(60, 0.52, 0.8)],
]) {
  const safeGrid = quantizeNotes(repeated, gridWithoutPhase).notes;
  assert.equal(safeGrid.length, repeated.length);
  assert.ok(safeGrid.every(n => n.end > n.startTimeSeconds));
  assert.ok(safeGrid[0].end <= safeGrid[1].startTimeSeconds + 1e-12);
  assert.ok(noteStats(fromInternal(safeGrid)).fragments <= noteStats(fromInternal(repeated)).fragments);
}
// Quantization must not combine two playable attacks into an unreachable chord.
const wideGrid = quantizeNotes([internalNote(60, 0.02, 0.2), internalNote(84, 0.07, 0.25)], gridWithoutPhase);
assert.equal(noteStats(fromInternal(wideGrid.notes)).handSpanViolations, 0);
for (const preset of ['easy', 'cover']) {
  const lineGrid = quantizeNotes([internalNote(60, 0.02, 0.2), internalNote(64, 0.07, 0.25)],
    gridWithoutPhase, { preset });
  assert.ok(lineGrid.notes[1].startTimeSeconds - lineGrid.notes[0].startTimeSeconds > 0.03);
}
const clickInput = clicks100.map(({ pitch, ...n }) => ({ ...n, pitchMidi: pitch }));
const pipelineGrid = coherenceNotes(clickInput, { quantize: true });
const pipelineUnquantized = coherenceNotes(clickInput, { quantize: false });
assert.equal(pipelineGrid.quantized, true);
assert.ok(Math.abs(pipelineGrid.estimatedBpm - 100) < 0.1);
assert.equal(pipelineGrid.length, pipelineUnquantized.length);
assert.equal(pipelineUnquantized.quantized, false);
assert.equal(pipelineUnquantized.estimatedBpm, 120);
assert.deepEqual(pipelineUnquantized.map(n => n.startTimeSeconds), clicks100.map(n => n.startTimeSeconds));
assert.ok(noteStats(pipelineGrid).fragments <= noteStats(pipelineUnquantized).fragments);
assert.equal(new midiPackage.Midi(notesToMidi(pipelineUnquantized)).header.tempos[0].bpm, 120);

// A seeded, 24 s accepted-tempo fixture makes the Cover bass rules observable end to end.
// Dense attacks are 180..220 ms apart, with weak pickups, longer harmony notes and changing chords.
let bassSeed = 11;
const bassRandom = () => ((bassSeed = (Math.imul(bassSeed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
// Hold the melody across every bass candidate: otherwise a bass-only attack in a melody rest
// deliberately gets the lone-line exemption instead of the accompaniment thinning rules below.
const bassFixture = Array.from({ length: 40 }, (_, i) => withOnset(84, 0.037 + i * 0.6, 0.58, 1, 1));
const bassCandidates = [];
for (let i = 0; i < 120; i++) {
  const start = 0.037 + Math.floor(i / 3) * 0.6 + 0.08 + i % 3 * 0.2 + (bassRandom() - 0.5) * 0.02;
  let pitch = [36, 38, 40, 41, 43][i % 5];
  let duration = 0.14 + 0.28 * bassRandom(), amplitude = 0.7 + 0.3 * bassRandom();
  // The first beat distinguishes capped duration from uncapped note-time.
  // The second beat's strongest attack repeats the still-held bass pitch class;
  // its runner-up must win instead of rejecting the whole bucket.
  if (i < 6) {
    pitch = [36, 38, 40, 26, 40, 41][i];
    duration = [1.2, 0.55, 0.14, 0.4, 0.25, 0.14][i];
    amplitude = [0.55, 0.95, 0.72, 0.98, 0.85, 0.73][i];
  }
  const bass = withOnset(pitch, start, duration, amplitude, 0.3);
  bassFixture.push(bass);
  bassCandidates.push(bass);
  if (i >= 6 && i % 3 !== 1) {
    for (const tone of [47, 50]) bassFixture.push(withOnset(tone, start, 0.13, 0.35, 0.3));
  }
}
const bassTiming = estimateTempo(bassFixture);
assert.equal(bassTiming.eligible, true);
assert.ok(Math.abs(bassTiming.estimatedBpm - 100) < 0.1);
assert.ok(bassTiming.gridPhaseSeconds > 0.03 && bassTiming.gridPhaseSeconds < 0.05);
const bassBeat = 60 / bassTiming.estimatedBpm;
const bassBucket = start => Math.floor((start - bassTiming.gridPhaseSeconds) / bassBeat + 1e-9);
const bassScore = n => n.amplitude * Math.min(n.durationSeconds, bassBeat);
const bassIdentity = n => `${n.pitch ?? n.pitchMidi}:${n.amplitude}`;
const bassOriginal = structuredClone(bassFixture);
const bassOutputs = [];
for (const quantize of [true, false]) {
  const arranged = coherenceNotes(bassFixture, { preset: 'cover', melody: 3, quantize });
  assert.equal(arranged.quantized, quantize);
  const left = arranged.filter(n => n.hand === 'left');
  const bass = left.filter(n => n.pitch < 44);
  const originals = bass.map(n => bassCandidates.find(candidate => bassIdentity(candidate) === bassIdentity(n)));
  assert.ok(originals.every(Boolean));
  assert.equal(new Set(originals.map(n => bassBucket(n.startTimeSeconds))).size, bass.length,
    'retain at most one original bass attack in each accepted-tempo bucket');
  assert.equal(bass.length, 40);
  assert.equal(new Set(bass.map(n => bassBucket(n.startTimeSeconds + arranged.timingOffsetSeconds))).size, bass.length,
    'the fixture also has one final attack per beat after snapping');
  let previous;
  for (const selected of originals) {
    const eligible = bassCandidates.filter(n => bassBucket(n.startTimeSeconds) === bassBucket(selected.startTimeSeconds) &&
      !(previous && previous.pitchMidi % 12 === n.pitchMidi % 12 &&
        previous.startTimeSeconds + previous.durationSeconds > n.startTimeSeconds));
    assert.ok(eligible.includes(selected), 'no repeated bass pitch class while its predecessor still sounds');
    assert.ok(eligible.every(n => bassScore(selected) >= bassScore(n) - 1e-9), 'keep the strongest eligible bass attack');
    assert.ok(eligible.every(n => Math.abs(bassScore(selected) - bassScore(n)) > 1e-9 ||
      selected.startTimeSeconds <= n.startTimeSeconds), 'score ties keep the earliest attack');
    previous = selected;
  }
  assert.deepEqual(originals.slice(0, 2).map(n => n.pitchMidi), [38, 40]);
  const attackGroups = [];
  for (const n of left) {
    const group = attackGroups.at(-1);
    if (group && n.startTimeSeconds - group[0].startTimeSeconds <= 0.03 + 1e-9) group.push(n);
    else attackGroups.push([n]);
  }
  assert.ok(attackGroups.filter(group => group.length > 1).length >= 8, 'exercise chord changes, not only isolated bass');
  assert.ok(attackGroups.every(group => group.some(n => bass.includes(n))), 'chord tones need their retained bass attack');
  for (let i = 1; i < bass.length; i++) {
    assert.ok(bass[i - 1].pitch % 12 !== bass[i].pitch % 12 ||
      bass[i - 1].startTimeSeconds + bass[i - 1].durationSeconds <= bass[i].startTimeSeconds,
    'snapping must not turn these bass re-attacks into held pitch-class duplicates');
  }
  bassOutputs.push(left.map(bassIdentity));
}
assert.deepEqual(bassOutputs[0], bassOutputs[1], 'quantize changes timing, not selected basses or chord tones');
assert.deepEqual(bassFixture, bassOriginal);
// These two attacks straddle the accepted phase, although a zero-phase grid puts them in one beat.
const phaseBoundaryBass = [
  ...Array.from({ length: 40 }, (_, i) => withOnset(84, 0.037 + i * 0.6, 0.59, 1, 1)),
  withOnset(36, 6.02, 0.13, 0.7, 0.3), withOnset(38, 6.2, 0.13, 1, 0.3),
];
const boundaryTempo = estimateTempo(phaseBoundaryBass);
assert.equal(boundaryTempo.eligible, true);
assert.ok(boundaryTempo.gridPhaseSeconds > 0.03 && boundaryTempo.gridPhaseSeconds < 0.05);
for (const quantize of [true, false]) {
  const arranged = coherenceNotes(phaseBoundaryBass, { preset: 'cover', melody: 3, quantize });
  assert.deepEqual(arranged.filter(n => n.hand === 'left').map(n => n.pitch), [36, 38],
    'bass buckets must use the accepted phase even when snapping is disabled');
}
// The sounding cap can remove a fragment before snapping; quantization must preserve that improvement.
const capGridInput = [withOnset(60, 0, 0.3, 1, 1), withOnset(62, 0.23, 0.27, 1, 1),
  withOnset(60, 0.33, 0.27, 1, 1), ...Array.from({ length: 40 }, (_, i) => withOnset(48, 3 + i * 0.6, 0.2, 1, 1))];
const capBeforeGrid = coherenceNotes(capGridInput, { maxSounding: 1, quantize: false });
const capAfterGrid = coherenceNotes(capGridInput, { maxSounding: 1, quantize: true });
assert.equal(capAfterGrid.quantized, true);
assert.equal(noteStats(capBeforeGrid).fragments, 0);
assert.equal(noteStats(capAfterGrid).fragments, 0);

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
const zeroOnsets = frames.map(row => row.map(() => 0));
const withoutOnsets = extractNotes(frames, zeroOnsets, { energyTolerance: 1 });
assert.deepEqual(extractNotes(frames, undefined, { energyTolerance: 1 }), withoutOnsets);
assert.deepEqual(extractNotes(frames, [], { energyTolerance: 1 }), withoutOnsets);
assert.deepEqual(extractNotes(frames, Array(frames.length), { energyTolerance: 1 }), withoutOnsets);
const incompleteOnsets = [[], undefined, Array(88).fill(NaN)];
const incompleteOriginal = structuredClone(incompleteOnsets);
assert.deepEqual(extractNotes(frames, incompleteOnsets, { energyTolerance: 1 }), withoutOnsets);
assert.deepEqual(incompleteOnsets, incompleteOriginal);
assert.deepEqual(extractNotes(zeroOnsets), []);
assert.deepEqual(extractNotes([frames[4]], undefined, { minMs: 0 }), []);

const strongOnsets = frames.map(row => row.map(() => 0));
strongOnsets[8][39] = 0.9;
const onsetNotes = extractNotes(frames, strongOnsets, { energyTolerance: 1 });
assert.ok(onsetNotes.some(n => n.onset === 0.9 && n.startTimeSeconds === 8 * 256 / 22050));
const nonfiniteOnsets = structuredClone(strongOnsets);
nonfiniteOnsets[2][0] = NaN;
assert.deepEqual(extractNotes(frames, nonfiniteOnsets, { energyTolerance: 1 }), onsetNotes);

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
const labelledMidi = new midiPackage.Midi(notesToMidi([
  { ...midiNotes[0], pitch: 75, hand: 'left' },
  { ...midiNotes[2], pitch: 45, hand: 'right' },
]));
assert.deepEqual(labelledMidi.tracks.map(track => track.notes.map(n => n.midi)), [[75], [45]]);
const labelledSingleTrack = new midiPackage.Midi(notesToMidi([
  { ...midiNotes[0], hand: 'right' }, { ...midiNotes[2], hand: 'left' },
], { splitHands: false }));
assert.equal(labelledSingleTrack.tracks.length, 1);
assert.equal(labelledSingleTrack.tracks[0].notes.length, 2);

const tempoNotes = Object.assign([
  { pitch: 60, startTimeSeconds: 0.6, durationSeconds: 0.15, velocity: 0.8 },
], { estimatedBpm: 100 });
const tempoMidi = new midiPackage.Midi(notesToMidi(tempoNotes));
close(tempoMidi.header.tempos[0].bpm, 100);
const tempoMidiNote = tempoMidi.tracks.flatMap(track => track.notes)[0];
assert.equal(tempoMidiNote.ticks, tempoMidi.header.ppq);
assert.equal(tempoMidiNote.durationTicks, tempoMidi.header.ppq / 4);
close(tempoMidiNote.time, 0.6);
close(tempoMidiNote.duration, 0.15);
for (const estimatedBpm of [undefined, NaN, Infinity, 0, 59, 181]) {
  assert.equal(new midiPackage.Midi(notesToMidi(Object.assign([...tempoNotes], { estimatedBpm })))
    .header.tempos[0].bpm, 120);
}

const readableMidi = notes => new midiPackage.Midi(notesToMidi(notes));
assert.equal(readableMidi([]).tracks.reduce((sum, track) => sum + track.notes.length, 0), 0);
// MIDI cannot represent separate re-strikes at the same tick; coalesce across hands.
const subTick = readableMidi([
  { pitch: 60, hand: 'left', startTimeSeconds: 0, durationSeconds: 0.0001, velocity: 0.3 },
  { pitch: 60, hand: 'right', startTimeSeconds: 0.0001, durationSeconds: 0.1, velocity: 0.8 },
  { pitch: 60, hand: 'right', startTimeSeconds: 0.05, durationSeconds: 0.2, velocity: 0.7 },
]);
const quantized = subTick.tracks.flatMap(track => track.notes).sort((a, b) => a.ticks - b.ticks);
assert.equal(quantized.length, 2);
assert.equal(quantized[0].ticks + quantized[0].durationTicks, quantized[1].ticks - 1);
assert.equal(subTick.tracks[0].notes[0].velocity, Math.floor(0.8 * 127) / 127);
assert.ok(quantized.every(n => n.durationTicks > 0));
// A right-to-left pitch handoff needs a tick of silence: the left track is encoded first.
const handoff = [
  { pitch: 55, hand: 'right', startTimeSeconds: 0, durationSeconds: 0.5, velocity: 0.7 },
  { pitch: 55, hand: 'left', startTimeSeconds: 0.5, durationSeconds: 0.5, velocity: 0.8 },
];
const handoffMidi = readableMidi(handoff);
const handoffLeft = handoffMidi.tracks[0].notes[0], handoffRight = handoffMidi.tracks[1].notes[0];
assert.equal(handoffLeft.ticks, 480);
assert.equal(handoffRight.ticks + handoffRight.durationTicks, handoffLeft.ticks - 1);
const handoffSingle = new midiPackage.Midi(notesToMidi(handoff, { splitHands: false })).tracks[0].notes;
assert.equal(handoffSingle[0].ticks + handoffSingle[0].durationTicks, handoffSingle[1].ticks);
const adjacentHandoff = readableMidi([
  { ...handoff[0], durationSeconds: 1 / 960 },
  { ...handoff[1], startTimeSeconds: 1 / 960 },
]).tracks.flatMap(track => track.notes);
assert.equal(adjacentHandoff.length, 1);
assert.ok(adjacentHandoff[0].durationTicks > 1);
const invalidMidi = readableMidi([
  null,
  { pitch: 60, startTimeSeconds: NaN, durationSeconds: 1, velocity: 1 },
  { pitch: 60, startTimeSeconds: 0, durationSeconds: 0, velocity: 1 },
  { pitch: 128, startTimeSeconds: 0, durationSeconds: 1, velocity: 1 },
  { pitch: 60, startTimeSeconds: 1e300, durationSeconds: 1, velocity: 1 },
  { pitch: 60, startTimeSeconds: 3600, durationSeconds: 0.0001, velocity: NaN },
  { pitch: 60, startTimeSeconds: 3601, durationSeconds: 1, velocity: 0 },
]);
const validMidiNotes = invalidMidi.tracks.flatMap(track => track.notes);
assert.equal(validMidiNotes.length, 2);
assert.ok(validMidiNotes.every(n => n.durationTicks > 0 && n.velocity > 0 && n.velocity <= 1));
assert.equal(validMidiNotes[0].ticks, 3600 * 960);

assert.deepEqual(noteStats([]), {
  notes: 0, seconds: 0, notesPerSec: 0, medianDurationMs: 0, pctUnder100ms: 0,
  durationP10: 0, durationP50: 0, durationP90: 0, maxDurationMs: 0,
  isolatedShortNotes: 0, sameHandGapsUnder100ms: 0,
  fragments: 0, meanOnsetAtFragmentStart: 0, maxSoundingAtOnce: 0,
  harmonicPairs: 0, harmonicPairsWeak: 0,
  chordGroups: 0, meanChordSpreadMs: 0, velocityP5: 0, velocityP50: 0, velocityP95: 0, quietShortNotes: 0,
  leftNotes: 0, rightNotes: 0, handSpanViolations: 0, handPolyViolations: 0, splitPoint: 60, playabilityDrops: 0,
  keyEstimate: null, outOfKeyPct: 0, meanSounding: 0, pctTimeSounding5plus: 0, wobblePairs: 0, melodyJumpRate: 0,
  estimatedBpm: 120, gridDeviationMs: 0, tempoConfidence: 0, phaseConfidence: 0,
  quantized: false, quantizedNotes: 0, timingOffsetSeconds: 0,
});
const timedStats = noteStats(Object.assign(fromInternal(snapped.notes), {
  estimatedBpm: snapped.estimatedBpm, gridDeviationMs: 12, tempoConfidence: 0.8,
  phaseConfidence: 0.6, quantized: true, quantizedNotes: 2, timingOffsetSeconds: snapped.timingOffsetSeconds,
}));
assert.equal(timedStats.estimatedBpm, 100);
assert.equal(timedStats.gridDeviationMs, 12); // Preserve the pre-quantization deviation in the final-note statistics.
assert.equal(timedStats.tempoConfidence, 0.8);
assert.equal(timedStats.phaseConfidence, 0.6);
assert.equal(timedStats.quantized, true);
assert.equal(timedStats.quantizedNotes, 2);
close(timedStats.timingOffsetSeconds, 0.037);

// Exact profile-shaped note-time gives a known key independent of amplitude and register.
const majorProfile = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const minorProfile = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const keyNotes = (profile, tonic = 0) => profile.map((durationSeconds, pitch) => ({
  pitch: 60 + tonic + pitch, startTimeSeconds: pitch, durationSeconds, amplitude: 1 / (pitch + 1),
}));
assert.equal(estimateKey([]), null);
assert.equal(estimateKey([null]), null);
assert.equal(estimateKey([{ pitch: 60, durationSeconds: NaN }]), null);
assert.equal(estimateKey(keyNotes(Array(12).fill(1))), null);
const cMajor = estimateKey(keyNotes(majorProfile));
assert.equal(cMajor.name, 'C major');
assert.equal(cMajor.tonic, 0);
assert.equal(cMajor.mode, 'major');
assert.deepEqual(cMajor.scale, [0, 2, 4, 5, 7, 9, 11]);
close(cMajor.correlation, 1);
const transposedMinor = estimateKey(keyNotes(minorProfile, 3));
assert.equal(transposedMinor.tonic, 3);
assert.equal(transposedMinor.mode, 'minor');
assert.deepEqual([...transposedMinor.scale].sort((a, b) => a - b), [1, 3, 5, 6, 8, 10, 11]);
close(transposedMinor.correlation, 1);
const keyStats = noteStats(keyNotes(majorProfile));
assert.equal(keyStats.keyEstimate, 'C major');
close(keyStats.outOfKeyPct, 100 * [1, 3, 6, 8, 10].reduce((sum, pc) => sum + majorProfile[pc], 0)
  / majorProfile.reduce((sum, duration) => sum + duration, 0));

const soundingStats = noteStats([
  ...[60, 62, 64, 65, 67].map(pitch => ({ pitch, startTimeSeconds: 10, durationSeconds: 2 })),
  { pitch: 69, startTimeSeconds: 11, durationSeconds: 2 },
  { pitch: 71, startTimeSeconds: 14, durationSeconds: 1 },
]);
close(soundingStats.meanSounding, 13 / 5); // Include the internal silence, exclude the leading ten seconds.
close(soundingStats.pctTimeSounding5plus, 40);
assert.equal(soundingStats.maxSoundingAtOnce, 6);
const metricLine = (pitches, times, hand = 'right') => pitches.map((pitch, i) => ({
  pitch, hand, startTimeSeconds: times[i], durationSeconds: 0.05,
}));
assert.equal(noteStats(metricLine([60, 61, 60, 61], [0, 0.1, 0.2, 0.3])).wobblePairs, 2);
assert.equal(noteStats(metricLine([60, 61, 60], [0, 0.15, 0.3])).wobblePairs, 1);
assert.equal(noteStats(metricLine([60, 61, 60], [0, 0.15001, 0.3])).wobblePairs, 0);
assert.equal(noteStats([
  ...metricLine([60, 61, 60], [0, 0.1, 0.2]),
  { pitch: 65, hand: 'right', startTimeSeconds: 0.11, durationSeconds: 0.05 },
]).wobblePairs, 0); // A semitone inside a hand chord is not a monophonic wobble.
assert.equal(noteStats([
  ...metricLine([60, 60], [0, 0.2]), ...metricLine([61], [0.1], 'left'),
]).wobblePairs, 0);
const jumpStats = noteStats([
  ...metricLine([60, 64, 72, 67, 76], [0, 0.01, 0.2, 0.4, 0.6]),
  ...metricLine([100, 30], [0, 0.2], 'left'),
]);
close(jumpStats.melodyJumpRate, 2 / 3); // Highest right-hand voice: 64→72→67→76.
assert.equal(noteStats(metricLine([60, 67], [0, 0.2])).melodyJumpRate, 0);
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
assert.equal(noteStats([{ pitch: 60, startTimeSeconds: 123,
  durationSeconds: 123.1 - 123 }]).pctUnder100ms, 0); // Subtracting large timestamps introduces rounding noise.
assert.equal(noteStats([{ pitch: 60, startTimeSeconds: 123,
  durationSeconds: 123.099999 - 123 }]).pctUnder100ms, 100); // A genuinely 99.999 ms note remains short.
assert.equal(stats.fragments, 2); // Touching notes and a 50 ms gap both count.
assert.ok(Math.abs(stats.meanOnsetAtFragmentStart - 0.3) < 1e-12); // Use each later note's onset.
assert.equal(stats.maxSoundingAtOnce, 2);
close(stats.durationP10, 86);
close(stats.durationP50, 110);
close(stats.durationP90, 176);
assert.equal(stats.maxDurationMs, 200);
assert.equal(stats.isolatedShortNotes, 1);
assert.equal(stats.sameHandGapsUnder100ms, 0);
assert.equal(noteStats([
  { pitch: 60, startTimeSeconds: 0.1, durationSeconds: 0.2 },
  { pitch: 60, startTimeSeconds: 0.3, durationSeconds: 0.2 },
]).maxSoundingAtOnce, 1); // Floating-point endpoint noise must not create an overlap.

const shortStats = noteStats([
  { pitch: 60, hand: 'right', startTimeSeconds: 0, durationSeconds: 0.08 },
  { pitch: 60, hand: 'right', startTimeSeconds: 0.2, durationSeconds: 0.12 },
  { pitch: 62, hand: 'left', startTimeSeconds: 0.28, durationSeconds: 0.12 },
  { pitch: 64, hand: 'left', startTimeSeconds: 0.401, durationSeconds: 0.2 },
  { pitch: 65, hand: 'left', startTimeSeconds: 0.701, durationSeconds: 0.08 },
  { pitch: 67, hand: 'left', startTimeSeconds: 0.88101, durationSeconds: 0.08 },
]);
assert.equal(shortStats.isolatedShortNotes, 2); // Exactly 120 ms to a same-pitch successor is not isolated.
assert.equal(shortStats.sameHandGapsUnder100ms, 2); // Include 1 and 100 ms, exclude 100.01 ms; respect hand labels.

const harmonicStats = noteStats([
  { pitch: 60, startTimeSeconds: 1, durationSeconds: 0.1, amplitude: 1 },
  { pitch: 67, startTimeSeconds: 1.03, durationSeconds: 0.1, amplitude: 0.8 },
  { pitch: 79, startTimeSeconds: 1.015, durationSeconds: 1, amplitude: 0.4 },
  { pitch: 84, startTimeSeconds: 1, durationSeconds: 1, amplitude: 0.6 },
  { pitch: 72, startTimeSeconds: 1.03001, durationSeconds: 1, amplitude: 0.1 },
]);
assert.equal(harmonicStats.harmonicPairs, 2); // Multiple lower matches count once; coverage is not a metric condition.
assert.equal(harmonicStats.harmonicPairsWeak, 1); // Strictly below 0.6; later lower-note starts qualify too.
assert.equal(noteStats([
  { pitch: 60, startTimeSeconds: 1, durationSeconds: 1, amplitude: 1 },
  { pitch: 72, startTimeSeconds: 1.03, durationSeconds: 1, amplitude: 0.5 },
]).harmonicPairsWeak, 1);
assert.equal(noteStats([
  { pitch: 60, startTimeSeconds: 0, durationSeconds: 1, amplitude: 0.04, velocity: 0.05 },
  { pitch: 72, startTimeSeconds: 0, durationSeconds: 1, amplitude: 0.01, velocity: 0.05 },
]).harmonicPairsWeak, 1); // Compare raw amplitude, before the velocity floor.

const chordStats = noteStats([
  { pitch: 60, startTimeSeconds: 0, durationSeconds: 0.2, amplitude: 0.5, velocity: 0.35 },
  { pitch: 64, startTimeSeconds: 0.02, durationSeconds: 0.1, amplitude: 0.1, velocity: 0.1 },
  { pitch: 67, startTimeSeconds: 0.04, durationSeconds: 0.2, amplitude: 0.5, velocity: 0.95 },
]);
assert.equal(chordStats.chordGroups, 1); // Groups use the first start, not a chain of adjacent gaps.
assert.equal(chordStats.meanChordSpreadMs, 20);
assert.equal(chordStats.quietShortNotes, 1);
assert.ok(Math.abs(chordStats.velocityP5 - 0.125) < 1e-12);
assert.equal(chordStats.velocityP50, 0.35);
assert.ok(Math.abs(chordStats.velocityP95 - 0.89) < 1e-12);
assert.equal(noteStats(toPianoNotes(localDynamics)).quietShortNotes, 1); // A whole soft passage stays quiet, not noisy.
assert.equal(noteStats([
  { pitch: 60, startTimeSeconds: 0, durationSeconds: 0.1, amplitude: 0.1, velocity: 0.7 },
  { pitch: 64, startTimeSeconds: 1, durationSeconds: 0.2, amplitude: 0.8, velocity: 0.7 },
]).quietShortNotes, 1); // Include the ±1 s boundary and measure raw amplitude rather than velocity.

const handStatsNotes = Object.assign([
  ...[30, 46].map(pitch => ({ pitch, hand: 'left', startTimeSeconds: 0, durationSeconds: 0.2 })),
  ...[60, 76].map(pitch => ({ pitch, hand: 'right', startTimeSeconds: 0.02, durationSeconds: 0.2 })),
  ...Array.from({ length: 6 }, (_, i) => ({ pitch: 30 + i, hand: 'left', startTimeSeconds: 1, durationSeconds: 0.2 })),
  ...Array.from({ length: 6 }, (_, i) => ({ pitch: 60 + i, hand: 'right', startTimeSeconds: 1, durationSeconds: 0.2 })),
], { splitPoint: 57.5, playabilityDrops: 3 });
const handStats = noteStats(handStatsNotes);
assert.equal(handStats.leftNotes, 8);
assert.equal(handStats.rightNotes, 8);
assert.equal(handStats.handSpanViolations, 1); // Count a group once even when both hands violate.
assert.equal(handStats.handPolyViolations, 1);
assert.equal(handStats.splitPoint, 57.5);
assert.equal(handStats.playabilityDrops, 3);
const explicitHandStats = noteStats([
  { pitch: 80, hand: 'left', startTimeSeconds: 0, durationSeconds: 1 },
  { pitch: 40, hand: 'right', startTimeSeconds: 2, durationSeconds: 1 },
  { pitch: 59, startTimeSeconds: 4, durationSeconds: 1 },
  { pitch: 60, startTimeSeconds: 6, durationSeconds: 1 },
]);
assert.equal(explicitHandStats.leftNotes, 2);
assert.equal(explicitHandStats.rightNotes, 2);

// Exercise the CLI failure path without decoding audio or invoking an external executable.
const savedSpawn = childProcess.spawnSync, savedArgv = process.argv, savedExit = process.exitCode;
const savedError = console.error, decodeErrors = [];
try {
  childProcess.spawnSync = () => ({ error: Object.assign(new Error('buffer exceeded'), { code: 'ENOBUFS' }) });
  syncBuiltinESMExports();
  console.error = message => decodeErrors.push(message);
  process.argv = [process.execPath, fileURLToPath(new URL('../cli.mjs', import.meta.url)), fileURLToPath(import.meta.url)];
  await import('../cli.mjs?decode-limit-test');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(process.exitCode, 1);
  assert.ok(decodeErrors.some(message => message.includes('256 MiB decode limit')));
} finally {
  childProcess.spawnSync = savedSpawn;
  syncBuiltinESMExports();
  process.argv = savedArgv;
  process.exitCode = savedExit;
  console.error = savedError;
}

// Browser smoke test: use real processing, with only the DOM/audio/model mocked.
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const browserSource = readFileSync(new URL('../main.js', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace('import.meta.env.BASE_URL', '"/"');
async function browserRun(preset, { empty = false, fail = false, quantize, fixture, splitHands } = {}) {
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) {
      const tag = html.match(new RegExp(`<[^>]+id="${selector.slice(1)}"[^>]*>`))?.[0] ?? '';
      elements.set(selector, { value: tag.match(/value="([^"]*)"/)?.[1] ?? '', checked: tag.includes('checked'),
        disabled: false, listeners: {}, addEventListener(type, listener) { this.listeners[type] = listener; } });
    }
    return elements.get(selector);
  };
  element('#preset').value = preset;
  if (quantize !== undefined) element('#quantize').checked = quantize;
  if (splitHands !== undefined) element('#split').checked = splitHands;
  element('#file').files = [{ name: 'song.mp3', arrayBuffer: async () => new ArrayBuffer(0) }];
  let extractionOptions, pianoOptions, output, midiBytes, midiOptions, downloadBlob;
  runInNewContext(browserSource, {
    pianoDefaults, defaultMaxSounding,
    document: { querySelector: element, getElementById: id => element(`#${id}`) },
    AudioContext: class { async decodeAudioData() { return { length: 1, numberOfChannels: 1,
      sampleRate: 22050, getChannelData: () => new Float32Array(1) }; } async close() {} },
    BasicPitch: class { model = Promise.resolve(); async evaluateModel(_, complete, progress) {
      complete(empty ? [] : fixture?.frames ?? frames, empty ? [] : fixture?.onsets ?? strongOnsets); progress(1);
    } },
    tf: { engine: () => ({ startScope() {}, endScope() {} }), getBackend: () => 'cpu' },
    extractNotes: (f, o, options) => { extractionOptions = options; if (fail) throw new Error('extract failed');
      return fixture?.notes ?? extractNotes(f, o, options); },
    toPianoNotes: (notes, options) => { pianoOptions = options; return pianoWithLengthDefaults(notes, options); },
    notesToMidi: (notes, options) => {
      output = notes; midiOptions = options; midiBytes = notesToMidi(notes, options); return midiBytes;
    },
    Blob, URL: { createObjectURL: blob => { downloadBlob = blob; return 'blob:test'; }, revokeObjectURL() {} },
    console: { error() {}, warn() {} },
  });
  await element('#form').listeners.submit({ preventDefault() {} });
  assert.equal(element('#controls').disabled, false);
  assert.equal(element('#convert').disabled, false);
  if (downloadBlob) midiBytes = new Uint8Array(await downloadBlob.arrayBuffer());
  return { element, extractionOptions, pianoOptions, output, midiBytes, midiOptions };
}
const cliExtraction = {
  onsetThresh: defaults.onset, frameThresh: defaults.frame, minMs: defaults.min, energyTolerance: defaults.tolerance,
};
const cliPiano = { ...defaults, maxPoly: defaults.poly };
const presetMarkup = html.match(/<select id="preset">([\s\S]*?)<\/select>/)[1];
assert.deepEqual([...presetMarkup.matchAll(/<option[^>]*value="([^"]+)"/g)].map(match => match[1]),
  ['full', 'easy', 'cover']);
const presetTags = [...presetMarkup.matchAll(/<option[^>]*>/g)].map(match => match[0]);
const selectedPresetTag = presetTags.find(tag => /\bselected\b/.test(tag)) ?? presetTags[0];
assert.equal(selectedPresetTag.match(/value="([^"]+)"/)[1], defaults.preset);
for (const preset of ['full', 'easy', 'cover']) {
  const browser = await browserRun(preset);
  assert.deepEqual({ ...browser.extractionOptions }, { ...pianoDefaults, ...cliExtraction });
  assert.deepEqual({ ...browser.pianoOptions }, {
    ...pianoDefaults, maxPoly: defaults.poly, maxSounding: defaultMaxSounding(preset), preset, quantize: defaults.quantize,
  });
  const cliNotes = pianoWithLengthDefaults(extractNotes(frames, strongOnsets, cliExtraction),
    { ...cliPiano, maxSounding: defaultMaxSounding(preset), preset });
  assert.deepEqual(browser.output, cliNotes);
  assert.match(browser.element('#summary').textContent, new RegExp(`^${cliNotes.length} notes`));
  assert.equal(browser.element('#download').hidden, false);
  const empty = await browserRun(preset, { empty: true });
  assert.match(empty.element('#summary').textContent, /^0 notes/);
  assert.match(empty.element('#status').textContent, preset === 'full' ? /lowering the thresholds/
    : new RegExp(`No notes remain in ${preset === 'cover' ? 'Cover' : 'Easy'}\\.`));
}
const browserUnquantized = await browserRun('full', { quantize: false });
assert.equal(browserUnquantized.pianoOptions.quantize, false);
assert.equal(browserUnquantized.output.estimatedBpm, 120);
assert.equal(browserUnquantized.output.quantized, false);
assert.deepEqual(extractNotes(frames, strongOnsets), extractNotes(frames, strongOnsets, {
  ...cliExtraction, energyTolerance: defaults.tolerance,
}));
const thresholdFrames = shortFrames.map(row => row.map(value => value ? 0.33 : 0));
const thresholdOnsets = shortOnsets.map(row => row.map(value => value ? 0.52 : 0));
assert.deepEqual(extractNotes(thresholdFrames, thresholdOnsets), extractNotes(thresholdFrames, thresholdOnsets, {
  ...cliExtraction, energyTolerance: defaults.tolerance,
}));
const defaultsFixture = [
  ...[0.9, 0.62, 0.67, 0.72].map((onset, i) => withOnset(60, i * 0.2, 0.2, 0.5, onset)),
  note(60, 2, 1, 0.5), note(72, 2.02, 1, 0.275), note(60, 4, 0.09, 0.8), note(62, 4.25, 0.2, 0.8),
  ...[48, 50, 52, 54, 56, 58, 60].map((pitch, i) => note(pitch, 6 + i * 0.004, 0.3, 0.4 + i / 10)),
  ...[60, 62, 64, 65, 67, 69].map((pitch, i) => note(pitch, 10 + i * 0.1, 1)),
  ...wobbleInput.map(n => ({ ...n, startTimeSeconds: n.startTimeSeconds + 20 })),
];
assert.deepEqual(pianoWithLengthDefaults(defaultsFixture), pianoWithLengthDefaults(defaultsFixture, cliPiano));
assert.deepEqual(pianoWithLengthDefaults(defaultsFixture),
  pianoWithLengthDefaults(defaultsFixture, Object.fromEntries(Object.keys(pianoDefaults).map(key => [key, undefined]))),
  'Explicit undefined options still use their defaults');

// A 24 s click track exercises the browser's real extraction, grid, MIDI tempo and checkbox forwarding.
const clickFrames = Array.from({ length: 2100 }, () => Array(88).fill(0));
const clickOnsets = Array.from({ length: 2100 }, () => Array(88).fill(0));
for (let k = 0; k < 40; k++) {
  const start = Math.round(k * 0.6 * 22050 / 256) + 3;
  clickOnsets[start][39] = 0.9;
  for (let f = start; f < start + 20; f++) clickFrames[f][39] = 0.7;
}
const browserClicks = { frames: clickFrames, onsets: clickOnsets };
for (const preset of ['full', 'easy', 'cover']) {
  const run = await browserRun(preset, { fixture: browserClicks });
  assert.equal(run.output.quantized, true, preset);
  assert.ok(Math.abs(run.output.estimatedBpm - 100) < 1, preset);
  assert.equal(run.output.length, 40, preset);
  assert.match(run.element('#summary').textContent, /^40 notes · [0-9.]+ seconds · [0-9.]+ BPM grid$/);
  assert.ok(run.element('#summary').textContent.endsWith(`${run.output.estimatedBpm.toFixed(1)} BPM grid`));
  assert.ok(Math.abs(new midiPackage.Midi(run.midiBytes).header.tempos[0].bpm - run.output.estimatedBpm) < 0.01);
  assert.equal(run.midiOptions.splitHands, true);
  const off = await browserRun(preset, { fixture: browserClicks, quantize: false });
  assert.equal(off.output.quantized, false);
  assert.equal(off.output.estimatedBpm, 120);
  assert.match(off.element('#summary').textContent, / · original timing$/);
  assert.equal(new midiPackage.Midi(off.midiBytes).header.tempos[0].bpm, 120);
  const single = await browserRun(preset, { fixture: browserClicks, splitHands: false });
  assert.equal(single.midiOptions.splitHands, false);
  assert.equal(new midiPackage.Midi(single.midiBytes).tracks.length, 1);
}

// This varied 36 s fixture exposes defaults that a single short note cannot exercise.
let paritySeed = 7;
const parityRandom = () => (paritySeed = (Math.imul(paritySeed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
const parityScale = [0, 2, 4, 5, 7, 9, 11], richSong = [];
let degree = 28;
for (let step = 0; step < 240; step++) {
  const start = Math.max(0, step * 0.15 + (parityRandom() - 0.5) * 0.02);
  if (step % 2 === 0) {
    degree = Math.max(21, Math.min(35, degree + Math.floor(parityRandom() * 5) - 2));
    richSong.push(withOnset(24 + Math.floor(degree / 7) * 12 + parityScale[degree % 7],
      start, 0.15 + parityRandom() * 0.5, 0.5 + parityRandom() * 0.5, 0.9));
  }
  if (step % 8 === 0) {
    for (const pitch of [36, 48, 52, 55, 60, 64].slice(0, 3 + Math.floor(parityRandom() * 4))) {
      richSong.push(withOnset(pitch, start + parityRandom() * 0.02, 1.2, 0.3 + parityRandom() * 0.6, 0.8));
    }
  }
  if (step % 5 === 0) {
    richSong.push(withOnset(61 + Math.floor(parityRandom() * 3) * 2, start + 0.04, 0.17, 0.3, 0.4));
  }
}
for (const preset of ['full', 'easy', 'cover']) {
  const browser = await browserRun(preset, { fixture: { notes: richSong } });
  const cli = pianoWithLengthDefaults(richSong, {
    ...cliPiano, preset, maxSounding: defaultMaxSounding(preset),
  });
  assert.deepEqual(browser.output, cli, `Browser / CLI defaults differ for ${preset}`);
  assert.deepEqual(browser.midiBytes, notesToMidi(cli), `Browser / CLI MIDI differs for ${preset}`);
}
const failedBrowser = await browserRun('full', { fail: true });
assert.match(failedBrowser.element('#status').textContent, /Could not create the MIDI file/);
assert.equal(failedBrowser.element('#download').hidden, true);

console.log('piano, extraction, MIDI, and statistics tests passed');
