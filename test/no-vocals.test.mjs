import assert from 'node:assert/strict';
import { arrangeStems } from '../stems.js';
import { toPianoNotes, pianoDefaults } from '../piano.js';
import { noteStats } from '../cli.mjs';

const note = (pitchMidi, startTimeSeconds, durationSeconds, amplitude = 0.8) =>
  ({ pitchMidi, startTimeSeconds, durationSeconds, amplitude, onset: 0.9 });
const options = { ...pianoDefaults, quantize: false, harmonic: 0, ghost: 0, keyClean: 0, align: 0 };
const tune = [67, 69, 71, 72, 74, 72, 71, 69, 67, 64, 65, 67, 72, 71, 69];
const melody = tune.map((pitch, i) => note(pitch, i, 0.85, 0.95));
const pad = Array.from({ length: 4 }, (_, i) => [48, 52, 55].map(p => note(p, i * 4, 4, 0.3))).flat();
const leak = [0, 2, 4, 6, 8, 10].map(t => note(61, t, 0.13, 0.2));
const provisional = arrangeStems(leak, pad, { ...options, durationSeconds: 15 });
assert.equal(provisional.noVocals, true);
assert.equal(provisional.vocalMedianPitch, null, 'Discarded leakage must not report a vocal median');
assert.equal(provisional.needsFallback, true, 'Missing instrumental lead requests original-mix transcription');
const output = arrangeStems(leak, pad, { ...options, durationSeconds: 15, fallbackNotes: [...melody, ...pad] });
assert.equal(output.noVocals, true);
assert.equal(output.needsFallback, false);
assert.equal(output.fallbackUsed, true);
assert.equal(output.vocalMedianPitch, null);
assert.equal(output.vocalDecisionMedianPitch, null);
assert.equal(output.vocalMelodyLeftShare, null, 'No vocal line has no vocal hand share');
assert.equal(output.fallbackMelodyLeftShare, 0);
const line = output.filter(n => n.role === 'melody');
assert.ok(line.every(n => n.source === 'instrumental'));
assert.deepEqual(line.map(n => n.pitch), tune, 'The prominent instrumental tune must survive above the pad');
for (const n of melody) {
  const actual = line.find(m => m.pitch === n.pitchMidi && Math.abs(m.startTimeSeconds - n.startTimeSeconds) < 0.02);
  assert.ok(actual?.durationSeconds >= n.durationSeconds - 0.02, 'Fallback retains the tune note time');
}
assert.ok(output.some(n => n.role !== 'melody'), 'The opposite hand must still provide backing');
for (const name of ['clashPct', 'handSpanViolations', 'handPolyViolations']) assert.equal(noteStats(output)[name], 0);

// Classic can retain short instrumental attacks. The vocal tracker's 160 ms
// spacing and 120 ms duration rules must not erase that instrumental line.
const quickTune = Array.from({ length: 20 }, (_, i) => note(74 + i % 3, i * 0.1, 0.08, 0.95));
const quickPad = [48, 52, 55].map(p => note(p, 0, 2, 0.2));
const classic = toPianoNotes([...quickTune, ...quickPad], options).filter(n => n.hand === 'right');
const quick = arrangeStems([], quickPad, { ...options, durationSeconds: 2, fallbackNotes: [...quickTune, ...quickPad] })
  .filter(n => n.role === 'melody');
assert.deepEqual(quick.map(n => n.pitch), classic.map(n => n.pitch), 'Keep every Classic instrumental attack');
assert.equal(quick.length, 20);

// A low-register tune is still a tune; the old pitch >=55 fallback discarded it.
const lowTune = melody.map(n => ({ ...n, pitchMidi: n.pitchMidi - 24 }));
const low = arrangeStems([], [], { ...options, durationSeconds: 15, fallbackNotes: lowTune, melodyHand: 'left' });
assert.deepEqual(low.filter(n => n.role === 'melody').map(n => n.pitch), lowTune.map(n => n.pitchMidi));
assert.ok(low.filter(n => n.role === 'melody').every(n => n.hand === 'left'));

// Many short leakage notes should not pass just by clearing the 15-note count.
const sparse = Array.from({ length: 20 }, (_, i) => note(61, i, 0.1, 0.2));
const continuous = Array.from({ length: 20 }, (_, i) => note(67 + i % 3, i, 0.8));
assert.equal(arrangeStems(sparse, continuous, { ...options, durationSeconds: 20 }).noVocals, true);
const vocals = Array.from({ length: 20 }, (_, i) => note(72, i * 0.3, 0.27));
const lateQuick = quickTune.map(n => ({ ...n, startTimeSeconds: n.startTimeSeconds + 8 }));
const partialQuick = arrangeStems(vocals, [], { ...options, quantize: true, durationSeconds: 10,
  fallbackNotes: lateQuick }).filter(n => n.role === 'melody' && n.startTimeSeconds >= 8);
assert.deepEqual(partialQuick.map(n => n.pitch), lateQuick.map(n => n.pitchMidi),
  'Vocal-song quantization guards must also preserve short notes in an instrumental section');
const section = arrangeStems([...vocals, ...sparse.filter(n => n.startTimeSeconds >= 8)],
  continuous, { ...options, durationSeconds: 20 });
assert.equal(section.noVocals, false);
assert.equal(section.needsFallback, true, 'Sparse vocal sections request the same instrumental fallback');
assert.ok(section.fallbackWindows.some(([start, end]) => start <= 8 && end >= 16));

// Fallback selection runs before hand assignment. A real instrumental intro
// must keep its source through the arranger so it cannot seed the sung line.
const highIntro = Array.from({ length: 10 }, (_, i) => note(76, i, 0.85, 0.95));
const introPad = Array.from({ length: 5 }, (_, i) =>
  [48, 52, 55].map(p => note(p, i * 4, Math.min(4, 18 - i * 4), 0.3))).flat();
for (const [pitch, hand] of [[58, 'left'], [62, 'right']]) {
  const sung = Array.from({ length: 20 }, (_, i) => note(pitch, 12 + i * 0.3, 0.27));
  const withIntro = arrangeStems(sung, introPad, {
    ...options, durationSeconds: 18, fallbackNotes: [...highIntro, ...introPad],
  });
  assert.equal(withIntro.noVocals, false);
  assert.equal(withIntro.vocalDecisionMedianPitch, pitch);
  assert.equal(withIntro.vocalMelodyLeftShare, hand === 'left' ? 1 : 0);
  assert.equal(withIntro.fallbackMelodyLeftShare, 0, 'The high intro keeps its own right-hand assignment');
  const sungOutput = withIntro.filter(n => n.role === 'melody' && n.source === 'vocal');
  assert.equal(sungOutput.length, sung.length, 'The intro fixture must retain the sung line');
  assert.ok(sungOutput.every(n => n.hand === hand),
    'Selected instrumental fallback cannot change the hand of the used vocal notes');
  assert.ok(withIntro.some(n => n.role === 'melody' && n.source === 'instrumental'),
    'The fixture must exercise an actual fallback intro');
}

const empty = arrangeStems([note(65, 0, 0.1)], [], { ...options, durationSeconds: 10, fallbackNotes: [] });
assert.equal(empty.length, 0);
assert.equal(empty.vocalMedianPitch, null);
assert.equal(empty.fallbackUsed, false);
console.log('no-vocals tune preservation, short instrumental notes, sparse leakage and section fallback tests passed');
