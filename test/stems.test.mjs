import assert from 'node:assert/strict';
import { arrangeStems, assignMelodyHands, enforcePlayability, filterClashes, groupBy30, inferChords,
  weightedMedianPitch, stemsDefaults } from '../stems.js';
import { noteStats, stemsDefaults as cliStemsDefaults } from '../cli.mjs';
import { notesToMidi } from '../midi.js';
import { backingCoverage } from '../backing-metrics.js';
import { auditMidi } from './song-audit.mjs';
import midiPackage from '@tonejs/midi';

const note = (pitch, start, length, amplitude = 0.8) => ({
  pitch, startTimeSeconds: start, durationSeconds: length, end: start + length, amplitude,
});
const phrase = (pitch, start, length = 5) => Array.from({ length: Math.ceil(length / 0.5) },
  (_, i) => note(pitch, start + i * 0.5, Math.min(0.45, length - i * 0.5)));
const noGrid = { eligible: false, estimatedBpm: 120, gridPhaseSeconds: 0,
  tempoConfidence: 0, phaseConfidence: 0, gridDeviationMs: 0 };
const grid = { ...noGrid, eligible: true, tempoConfidence: 1, phaseConfidence: 1 };

assert.equal(cliStemsDefaults, stemsDefaults, 'The CLI must use the shared frozen stems defaults object');
assert.equal(Object.isFrozen(stemsDefaults), true);
assert.equal(weightedMedianPitch([note(48, 0, 3), note(72, 4, 1), note(72, 6, 1)]), 48);
assert.equal(weightedMedianPitch([]), null);
let assignment = assignMelodyHands([...phrase(52, 0), ...phrase(72, 7)], noGrid);
assert.deepEqual(assignment.phrases.map(p => p.hand), ['left', 'right']);
assert.ok(assignment.notes.slice(0, 10).every(n => n.pitch === 52));
assignment = assignMelodyHands([...phrase(52, 0), ...phrase(58, 7), ...phrase(72, 14), ...phrase(58, 21)], noGrid);
assert.deepEqual(assignment.phrases.map(p => p.hand), ['left', 'left', 'right', 'right']);
assert.equal(assignMelodyHands(phrase(59, 0)).phrases[0].hand, 'left',
  'A vocal median below 59.5 seeds the boundary band in the left hand');
assert.equal(assignMelodyHands(phrase(58, 0)).phrases[0].hand, 'left');
assignment = assignMelodyHands([...phrase(52, 0), ...phrase(72, 6.5, 1), ...phrase(52, 9)], noGrid);
assert.deepEqual(assignment.phrases.map(p => p.hand), ['left', 'left', 'left'], 'A short high phrase cannot flip the hand');
assignment = assignMelodyHands([...phrase(72, 0, 1), ...phrase(52, 2.5)], noGrid);
assert.deepEqual(assignment.phrases.map(p => p.hand), ['left', 'left'], 'An initial short phrase shares its next neighbour');
assignment = assignMelodyHands([...phrase(52, 0, 2), ...phrase(53, 4, 2), ...phrase(72, 8, 2), ...phrase(74, 12, 2)]);
assert.deepEqual(assignment.phrases.map(p => p.hand), ['left', 'left', 'right', 'right'],
  'Neighbouring short phrases can jointly establish a later register change');
assert.equal(assignMelodyHands([note(30, 0, 1), note(100, 2, 1)]).notes[0].pitch, 42);
assert.equal(assignMelodyHands([note(30, 0, 1), note(100, 2, 1)]).notes[1].pitch, 88);
assert.ok(assignMelodyHands([note(1e100, 0, 1)]).notes.every(n => n.pitch >= 36 && n.pitch <= 96));
assert.equal(assignMelodyHands([note(30, 0, 1)], noGrid, { melodyOctave: 1 }).notes[0].pitch, 42,
  'Shift the original pitch before folding notes outside the piano range');
assert.equal(assignMelodyHands([note(100, 0, 1)], noGrid, { melodyOctave: -1 }).notes[0].pitch, 88);
assert.equal(assignMelodyHands(phrase(67, 0), noGrid, { melodyOctave: -1 }).phrases[0].hand, 'left',
  'Auto assigns the hand from the shifted register');
assert.throws(() => assignMelodyHands([], noGrid, { melodyHand: 'both' }), /melodyHand/);
assert.throws(() => assignMelodyHands([], noGrid, { melodyOctave: 2 }), /melodyOctave/);
const rests = [note(52, 0, 1), note(72, 2.2, 1)];
assert.equal(assignMelodyHands(rests, noGrid).phrases.length, 2);
assert.equal(assignMelodyHands(rests, { ...grid, estimatedBpm: 60 }).phrases.length, 1, 'Accepted tempo uses two beats');

const sourcedPhrase = (pitch, start, length, source) =>
  phrase(pitch, start, length).map(n => ({ ...n, source }));
for (const [pitch, hand] of [[58, 'left'], [62, 'right']]) {
  const vocals = [...sourcedPhrase(pitch, 14, 7, 'vocal'), ...sourcedPhrase(pitch, 23, 5, 'vocal')];
  const alone = assignMelodyHands(vocals, noGrid);
  const withIntro = assignMelodyHands([...sourcedPhrase(76, 0, 12, 'instrumental'), ...vocals], noGrid);
  assert.equal(withIntro.vocalDecisionMedianPitch, pitch);
  assert.deepEqual(withIntro.phrases.filter(p => p.source === 'vocal').map(p => p.hand),
    alone.phrases.map(p => p.hand), 'An instrumental intro must not seed the sung melody hand');
  assert.ok(withIntro.notes.filter(n => n.source === 'vocal').every(n => n.hand === hand));
  assert.ok(withIntro.notes.filter(n => n.source === 'instrumental').every(n => n.hand === 'right'));
}
assignment = assignMelodyHands([...phrase(58, 0), ...phrase(62, 7, 10)], noGrid);
assert.equal(assignment.vocalDecisionMedianPitch, 62);
assert.deepEqual(assignment.phrases.map(p => p.hand), ['right', 'right'],
  'The whole vocal line seeds a first boundary-band phrase, not its first phrase alone');
assignment = assignMelodyHands([
  ...sourcedPhrase(52, 0, 5, 'vocal'),
  ...sourcedPhrase(76, 5, 5, 'instrumental'),
  ...sourcedPhrase(58, 10, 5, 'vocal'),
], noGrid);
assert.deepEqual(assignment.phrases.map(p => [p.source, p.hand]),
  [['vocal', 'left'], ['instrumental', 'right'], ['vocal', 'left']],
  'Source changes split adjacent phrases and a high fallback cannot change the vocal state');
assignment = assignMelodyHands([
  ...sourcedPhrase(62, 0, 5, 'vocal'),
  ...sourcedPhrase(52, 7, 5, 'instrumental'),
  ...sourcedPhrase(58, 14, 5, 'vocal'),
], noGrid);
assert.deepEqual(assignment.phrases.map(p => p.hand), ['right', 'left', 'right'],
  'A low fallback cannot reset an established right-hand vocal state');
for (const [vocalPitch, hand] of [[52, 'left'], [72, 'right']]) for (const fallbackPitch of [58, 59]) {
  assignment = assignMelodyHands([
    ...sourcedPhrase(vocalPitch, 0, 5, 'vocal'),
    ...sourcedPhrase(fallbackPitch, 7, 5, 'instrumental'),
    ...sourcedPhrase(vocalPitch, 14, 5, 'vocal'),
  ], noGrid);
  assert.equal(assignment.phrases[1].hand, hand,
    'A boundary-band fallback adopts matching vocal hands on either side');
}
assignment = assignMelodyHands([
  ...sourcedPhrase(52, 0, 1, 'vocal'),
  ...sourcedPhrase(52, 2.5, 5, 'instrumental'),
  ...sourcedPhrase(62, 9, 5, 'vocal'),
], noGrid);
assert.deepEqual(assignment.phrases.map(p => p.hand), ['right', 'left', 'right'],
  'A short vocal phrase shares the next vocal decision, excluding an intervening fallback');
assert.equal(assignment.phrases[0].decisionMedianPitch, 62);
assignment = assignMelodyHands([
  ...sourcedPhrase(52, 0, 2, 'vocal'),
  ...sourcedPhrase(76, 3.5, 2, 'instrumental'),
  ...sourcedPhrase(53, 7, 2, 'vocal'),
  ...sourcedPhrase(76, 10.5, 2, 'instrumental'),
  ...sourcedPhrase(72, 14, 2, 'vocal'),
  ...sourcedPhrase(74, 18, 2, 'vocal'),
], noGrid);
assert.deepEqual(assignment.phrases.filter(p => p.source === 'vocal').map(p => p.hand),
  ['left', 'left', 'right', 'right'], 'Pairs of short vocal phrases must exclude fallback phrases');
assignment = assignMelodyHands([
  ...sourcedPhrase(76, 0, 5, 'instrumental'), ...sourcedPhrase(70, 7, 5, 'vocal'),
], noGrid, { melodyOctave: -1 });
assert.equal(assignment.vocalDecisionMedianPitch, 58);
assert.ok(assignment.notes.filter(n => n.source === 'vocal').every(n => n.pitch === 58 && n.hand === 'left'),
  'The vocal-only seed uses the octave-shifted register');
for (const melodyHand of ['left', 'right']) for (const melodyOctave of [-1, 0, 1]) {
  const mixed = [...sourcedPhrase(72, 0, 5, 'instrumental'), ...sourcedPhrase(58, 5, 5, 'vocal')];
  const forced = assignMelodyHands(mixed, noGrid, { melodyHand, melodyOctave });
  assert.ok(forced.notes.every((n, i) => n.hand === melodyHand && n.pitch === mixed[i].pitch + 12 * melodyOctave),
    'Source-aware Auto decisions must not change forced hand or octave controls');
}

const harmonyNotes = [];
for (const [i, pitches] of [[48, 52, 55], [43, 47, 50], [45, 48, 52], [41, 45, 48]].entries()) {
  for (let t = i * 4; t < i * 4 + 4; t += 0.5) for (const pitch of pitches) harmonyNotes.push(note(pitch, t, 0.48));
}
const harmony = inferChords(harmonyNotes, grid);
assert.deepEqual(harmony.segments.map(s => s.root), [0, 7, 9, 5]);
assert.deepEqual(harmony.segments.map(s => s.label), ['C', 'G', 'Am', 'F']);
assert.equal(inferChords([], noGrid).segments.length, 0);
const ambiguous = [...phrase(48, 0), ...phrase(55, 0)];
const majorMelody = inferChords(ambiguous, grid, null, { melody: phrase(64, 0) });
const minorMelody = inferChords(ambiguous, grid, null, { melody: phrase(63, 0) });
assert.equal(majorMelody.segments[0].label, 'C', 'A strong-beat major third rewards the major template');
assert.equal(minorMelody.segments[0].label, 'Cm', 'A strong-beat minor third rewards the minor template');

const clashing = [
  { ...note(60, 0, 2), hand: 'right', role: 'melody' },
  { ...note(59, 0, 2), hand: 'left', role: 'accompaniment', chordTones: [11, 7], registerLow: 48,
    registerHigh: 59, placement: 'below' },
];
const filtered = filterClashes(clashing);
assert.equal(filtered.length, 2);
assert.equal(filtered.find(n => n.role === 'accompaniment').pitch, 55, 'B under C is revoiced to the nearest safe chord tone G');
assert.equal(clashing[1].pitch, 59, 'The post-filter must not mutate caller notes');
assert.equal(filterClashes([clashing[0], { ...clashing[1], chordTones: [11], registerLow: 59 }]).length, 1,
  'An impossible chord tone is dropped');
assert.equal(filterClashes([
  { ...note(60, 0, 1), hand: 'left', role: 'melody' },
  { ...note(61, 0, 1), hand: 'right', role: 'accompaniment', chordTones: [1, 4], registerLow: 60,
    registerHigh: 81, placement: 'above' },
]).find(n => n.role === 'accompaniment').pitch, 64);
assert.equal(filterClashes([
  { ...note(60, 0, 1), hand: 'right', role: 'melody' },
  { ...note(62, 1, 1), hand: 'right', role: 'melody' },
  { ...note(59, 0, 2), hand: 'left', role: 'accompaniment', chordTones: [11, 7], registerLow: 48,
    registerHigh: 59, placement: 'below' },
]).find(n => n.role === 'accompaniment').pitch, 55, 'A held backing note is checked against the whole overlapping line');
const regrouped = enforcePlayability([
  { ...note(40, 0, 1, 0.1), hand: 'left', role: 'bass' },
  { ...note(52, 0.02, 1, 0.2), hand: 'left', role: 'accompaniment' },
  { ...note(68, 0.04, 1, 0.4), hand: 'left', role: 'accompaniment' },
  { ...note(40, 0.05, 0.3, 0.8), hand: 'right', role: 'melody' },
]);
assert.ok(!regrouped.some(n => n.pitch === 52), 'Removing a short anchor must re-check the newly joined attack group');
for (const group of groupBy30(regrouped)) for (const hand of ['left', 'right']) {
  const pitches = group.filter(n => n.hand === hand).map(n => n.pitch);
  if (pitches.length) assert.ok(Math.max(...pitches) - Math.min(...pitches) <= 14);
}
const independentlyAnchored = enforcePlayability([
  { ...note(60, 0, 1), hand: 'right', role: 'melody' },
  { ...note(40, 0.02, 1, 0.2), hand: 'left', role: 'accompaniment' },
  { ...note(56, 0.04, 1, 0.4), hand: 'left', role: 'accompaniment' },
]);
assert.ok(!independentlyAnchored.some(n => n.pitch === 40),
  'Each hand also has its own 30 ms anchors, independent of the other hand');
const roundedGroups = enforcePlayability([
  { ...note(60, 0, 1), hand: 'right', role: 'melody' },
  { ...note(40, 0.0204, 1, 0.2), hand: 'left', role: 'accompaniment' },
  { ...note(56, 0.0505, 1, 0.4), hand: 'left', role: 'accompaniment' },
]);
assert.ok(!roundedGroups.some(n => n.pitch === 40),
  'MIDI tick rounding can join notes that were just over 30 ms apart');
const leftRootOverlap = enforcePlayability([
  { ...note(48, 0, 1, 0.4), hand: 'left', role: 'bass' },
  { ...note(52, 0.1, 1, 0.5), hand: 'left', role: 'bass' },
  { ...note(60, 0.2, 0.3), hand: 'left', role: 'melody' },
]);
assert.ok(leftRootOverlap.filter(n => n.startTimeSeconds <= 0.2 &&
  n.startTimeSeconds + n.durationSeconds > 0.2).length <= 2,
  'The left hand carries at most melody plus one bass root');

const options = { quantize: false, tempo: noGrid, harmonic: 0, ghost: 0, keyClean: 0, legato: 0,
  align: 0, chordsOnly: true };
const voice = (pitch, start = 0) => Array.from({ length: 20 }, (_, i) => note(pitch, start + i * 0.3, 0.27));
const backing = Array.from({ length: 12 }, (_, i) => [48, 52, 55].map(p => note(p, i * 0.5, 0.48))).flat();
const assertBacking = output => {
  const backing = output.filter(n => n.role !== 'melody'), stats = noteStats(output);
  for (const chord of output.chords.filter(c => c.label !== 'N')) {
    assert.ok(backing.some(n => n.startTimeSeconds < chord.end && n.end > chord.start),
      `${chord.label} at ${chord.start} must have backing`);
  }
  assert.ok(backingCoverage(output).noBackingPct <= 5, JSON.stringify(backingCoverage(output)));
  assert.equal(stats.clashPct, 0);
  assert.equal(stats.handSpanViolations, 0);
  assert.equal(stats.handPolyViolations, 0);
  assert.ok(stats.maxSoundingAtOnce <= 4);
  assert.ok(output.every(n => Number.isFinite(n.pitch) && n.durationSeconds > 0));
  assert.equal(auditMidi(notesToMidi(output)).pass, true);
};
for (let root = 0; root < 12; root++) {
  const power = Array.from({ length: 12 }, (_, i) =>
    [48 + root, 55 + root].map(p => note(p, i * 0.5, 0.48))).flat();
  const output = arrangeStems(voice(72 + root), power, { ...options, melodyHand: 'right', chordsOnly: false });
  assert.ok(output.chords.some(chord => chord.root === root && chord.label.endsWith('5')),
    `The fixture must exercise the power chord on pitch class ${root}`);
  assertBacking(output);
}
// One long LH phrase reaches G5 only briefly. A high peak must not decide
// every chord's floor, nor remove a whole long power-chord accompaniment.
const peaks = Array.from({ length: 80 }, (_, i) => note(i === 18 || i === 54 ? 79 : i % 7 === 0 ? 57 : 53,
  i * 0.3, 0.27));
const longPower = Array.from({ length: 48 }, (_, i) => [51, 58].map(p => note(p, i * 0.5, 0.48))).flat();
for (const melodyHand of ['auto', 'left']) {
  const output = arrangeStems(peaks, longPower, { ...options, melodyHand });
  assert.equal(output.melodyLeftShare, 1);
  assertBacking(output);
  assert.ok(output.some(n => n.role !== 'melody' && n.hand === 'right' && n.pitch <= 72),
    'Ordinary low melody stretches retain backing in the normal RH register');
  for (const n of output.filter(n => n.role !== 'melody')) for (const m of output.filter(n => n.role === 'melody')) {
    if (n.startTimeSeconds >= m.end - 1e-9 || m.startTimeSeconds >= n.end - 1e-9) continue;
    assert.ok(n.hand === 'right' ? n.pitch >= Math.max(60, m.pitch + 3) :
      m.pitch - n.pitch >= 3 && m.pitch - n.pitch <= 14);
  }
}
const forcedHigh = arrangeStems(voice(79), backing, { ...options, melodyHand: 'left' });
assertBacking(forcedHigh);
assert.ok(forcedHigh.filter(n => n.role !== 'melody').every(n => n.hand === 'left' && n.role === 'bass'),
  'When nothing fits above a forced high LH melody, one safe tone below it preserves backing');
const afterPeak = arrangeStems(voice(79),
  Array.from({ length: 20 }, (_, i) => (i < 14 ? [48, 52, 55] : [50, 54, 57])
    .map(p => note(p, i * 0.5, 0.49))).flat(),
  { ...options, melodyHand: 'left', fallbackNotes: [], durationSeconds: 10 });
assertBacking(afterPeak);
assert.ok(afterPeak.some(n => n.role !== 'melody' && n.hand === 'right' && n.startTimeSeconds >= 7),
  'A finished high LH phrase must not raise the RH floor through a later empty melody section');
const forcedLow = arrangeStems(voice(38),
  Array.from({ length: 12 }, (_, i) => [40, 44, 47].map(p => note(p, i * 0.5, 0.48))).flat(),
  { ...options, melodyHand: 'right' });
assertBacking(forcedLow);
assert.ok(forcedLow.filter(n => n.role !== 'melody').every(n =>
  n.hand === 'right' && n.pitch >= 41 && n.pitch <= 52),
  'When nothing fits below a forced low RH melody, one safe tone above it preserves backing');
assert.ok(forcedLow.filter(n => n.role === 'melody').every(n => n.hand === 'right' && n.pitch === 38));
for (const pitch of [52, 72]) for (const quantize of [false, true]) {
  const output = arrangeStems(voice(pitch), backing, { ...options, quantize, tempo: quantize ? grid : noGrid });
  const melody = output.filter(n => n.role === 'melody'), accompaniment = output.filter(n => n.role !== 'melody');
  assert.equal(output.noVocals, false);
  assert.equal(output.vocalMedianPitch, pitch);
  assert.ok(melody.length >= 15);
  assert.ok(melody.every(n => n.pitch === pitch), 'The melody remains at its real pitch');
  assert.ok(melody.every(n => n.hand === (pitch < 60 ? 'left' : 'right')));
  assert.ok(accompaniment.some(n => n.hand === (pitch < 60 ? 'right' : 'left')));
  for (const n of accompaniment) for (const m of melody) {
    if (n.startTimeSeconds >= m.startTimeSeconds + m.durationSeconds - 1e-9 ||
      m.startTimeSeconds >= n.startTimeSeconds + n.durationSeconds - 1e-9) continue;
    assert.ok(![1, 11].includes(Math.abs(n.pitch - m.pitch) % 12));
    if (pitch >= 60) assert.ok(n.pitch <= m.pitch - 2);
    else if (n.hand === 'right') assert.ok(n.pitch >= Math.max(60, pitch + 3) && n.pitch <= 81);
    else assert.ok(m.pitch - n.pitch >= 5 && m.pitch - n.pitch <= 12);
  }
  for (const group of groupBy30(output)) for (const hand of ['left', 'right']) {
    const pitches = group.filter(n => n.hand === hand).map(n => n.pitch);
    assert.ok(pitches.length <= 5);
    if (pitches.length) assert.ok(Math.max(...pitches) - Math.min(...pitches) <= 14);
  }
  assert.ok(output.every(n => n.durationSeconds > 0));
  const stats = noteStats(output);
  assert.equal(stats.clashPct, 0);
  assert.ok(stats.maxSoundingAtOnce <= 4);
  const midi = new midiPackage.Midi(notesToMidi(output));
  const midiNotes = midi.tracks.flatMap((track, hand) => track.notes.map(n => ({ ...n, hand })));
  for (const n of midiNotes) {
    assert.ok(n.durationTicks > 0);
    for (const m of midiNotes) if (m !== n && m.midi === n.midi) {
      assert.ok(n.ticks + n.durationTicks <= m.ticks || m.ticks + m.durationTicks <= n.ticks);
    }
  }
}
for (const melodyHand of ['left', 'right']) for (const melodyOctave of [-1, 0, 1]) {
  const pitch = melodyHand === 'left' ? 60 : 64;
  const output = arrangeStems(voice(pitch), backing, { ...options, melodyHand, melodyOctave });
  const melody = output.filter(n => n.role === 'melody'), accompaniment = output.filter(n => n.role !== 'melody');
  const shifted = pitch + 12 * melodyOctave;
  assert.ok(melody.length >= 15 && accompaniment.length > 0);
  assert.ok(melody.every(n => n.pitch === shifted && n.hand === melodyHand));
  assert.ok(accompaniment.every(n => n.hand !== melodyHand), 'Forced hand reserves the whole hand for the melody');
  for (const n of accompaniment) for (const m of melody) {
    if (n.startTimeSeconds >= m.end - 1e-9 || m.startTimeSeconds >= n.end - 1e-9) continue;
    assert.ok(melodyHand === 'left' ? n.pitch >= Math.max(60, shifted + 3) : n.pitch <= shifted - 2);
  }
  const stats = noteStats(output);
  assert.equal(stats.clashPct, 0);
  assert.equal(stats.handSpanViolations, 0);
  assert.equal(stats.handPolyViolations, 0);
  assert.equal(stats.melodyLeftShare, melodyHand === 'left' ? 1 : 0);
  assert.equal(stats.melodyMedianPitch, shifted);
}
const instrumentalOnly = arrangeStems([], harmonyNotes.map(n => ({ ...n, pitch: n.pitch + 12 })), options);
assert.equal(instrumentalOnly.noVocals, true);
assert.ok(instrumentalOnly.some(n => n.role === 'melody'));
const shiftedFallback = arrangeStems([], harmonyNotes.map(n => ({ ...n, pitch: n.pitch + 12 })),
  { ...options, melodyHand: 'left', melodyOctave: -1 });
assert.deepEqual(shiftedFallback.filter(n => n.role === 'melody').map(n => n.pitch),
  instrumentalOnly.filter(n => n.role === 'melody').map(n => n.pitch - 12),
  'The octave control applies equally to the instrumental fallback melody');
assert.ok(shiftedFallback.filter(n => n.role === 'melody').every(n => n.hand === 'left'));
const withGap = arrangeStems([...voice(72), ...voice(72, 10)],
  Array.from({ length: 32 }, (_, i) => [48, 55, 64].map(p => note(p, i * 0.5, 0.45))).flat(), options);
assert.ok(withGap.some(n => n.role === 'melody' && n.startTimeSeconds > 6.2 && n.startTimeSeconds < 9.9),
  'A long vocal rest receives an instrumental melody');
assert.equal(arrangeStems([], [], options).length, 0);
const fastVocal = Array.from({ length: 20 }, (_, i) => note(52 + i % 2, i * 0.18, 0.14));
const protectedVocal = arrangeStems(fastVocal, [], { ...options, quantize: true, rhLegato: 0,
  tempo: { ...grid, estimatedBpm: 126 } });
assert.equal(protectedVocal.length, fastVocal.length);
assert.ok(protectedVocal.every(n => n.durationSeconds >= 0.12 - 1e-9),
  'A 119 ms sixteenth must not shorten a valid vocal note below the tracker floor');
for (let i = 1; i < protectedVocal.length; i++) assert.ok(
  protectedVocal[i].startTimeSeconds - protectedVocal[i - 1].startTimeSeconds >= 0.16 - 1e-9,
  'Grid snapping must preserve the melody onset spacing');
const steadyAttacks = Array.from({ length: 40 }, (_, i) => ({ ...note(60, 0.03 + i * 0.5, 0.2), onset: 0.9 }));
const continuations = Array.from({ length: 45 }, (_, i) => ({ ...note(53 + i % 3, 0.11 + i * 0.41, 1.4), onset: 0 }));
const attackArrangement = arrangeStems([], steadyAttacks, { ...options, tempo: undefined, quantize: true });
const sustainArrangement = arrangeStems([], [...steadyAttacks, ...continuations], { ...options, tempo: undefined, quantize: true });
assert.equal(attackArrangement.estimatedBpm, sustainArrangement.estimatedBpm);
assert.equal(attackArrangement.gridPhaseSeconds, sustainArrangement.gridPhaseSeconds,
  'Adding onset-less harmonic continuations must not move the attack-derived beat grid');

console.log('stems arrangement, native-register hands, fallback, clash, and MIDI invariant tests passed');
