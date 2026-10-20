// Optional local regression: no copyrighted audio, downloads or inference in CI.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { extractNotes } from '../extract.js';
import { pianoDefaults, toPianoNotes } from '../piano.js';
import { arrangeStems } from '../stems.js';
import { noteStats } from '../cli.mjs';
import { notesToMidi } from '../midi.js';

const cache = '.cache/tune-pad-15s.wav-2646044';
if (!existsSync(cache + '.json') || !existsSync(cache + '-stems.json')) {
  console.log('SKIP no-vocals local golden: tune-pad inference caches are absent.');
} else {
  const mix = JSON.parse(readFileSync(cache + '.json')), stems = JSON.parse(readFileSync(cache + '-stems.json'));
  const options = { ...pianoDefaults, durationSeconds: stems.duration };
  const instrumental = extractNotes(stems.frames, stems.onsets, { ...options, melodiaTrick: false });
  const fullMix = extractNotes(mix.frames, mix.onsets, options);
  const provisional = arrangeStems(stems.melody, instrumental, options);
  const piano = arrangeStems(stems.melody, instrumental, { ...options, fallbackNotes: fullMix });
  const classic = toPianoNotes(fullMix, options);
  const reference = classic.filter(n => n.hand === 'right');
  const actual = piano.filter(n => n.role === 'melody');
  const matches = reference.map(n => actual.find(m => m.pitch === n.pitch &&
    Math.abs(m.startTimeSeconds - n.startTimeSeconds) <= 0.125));
  // Compare playable monophonic note time: Classic may overlap successive RH
  // notes, whereas the stems lead is one voice with a small key release.
  let referenceTime = 0, preservedTime = 0;
  reference.forEach((n, i) => {
    const end = Math.min(n.startTimeSeconds + n.durationSeconds, reference[i + 1]?.startTimeSeconds ?? Infinity);
    const length = Math.max(0, end - n.startTimeSeconds);
    referenceTime += length;
    if (matches[i]) preservedTime += Math.min(length, matches[i].durationSeconds);
  });
  assert.equal(provisional.noVocals, true);
  assert.equal(provisional.needsFallback, true);
  assert.equal(piano.noVocals, true);
  assert.equal(piano.needsFallback, false);
  assert.equal(piano.fallbackUsed, true);
  assert.equal(piano.vocalMedianPitch, null);
  assert.ok(reference.length >= 8, 'Frozen clip must still exercise the actual Classic tune fragment');
  assert.equal(matches.filter(Boolean).length, reference.length, 'Preserve every Classic prominent-line attack');
  assert.ok(preservedTime / referenceTime >= 0.95, 'Keep at least 95% of Classic monophonic melody note time');
  const statistics = noteStats(piano);
  for (const name of ['clashPct', 'handSpanViolations', 'handPolyViolations']) assert.equal(statistics[name], 0);
  mkdirSync('.cache/run3', { recursive: true });
  mkdirSync('.cache/listen', { recursive: true });
  writeFileSync('.cache/listen/tune-pad-15s-stems.mid', notesToMidi(piano));
  writeFileSync('.cache/listen/tune-pad-15s-stems-notes.json', JSON.stringify({
    notes: piano, stats: statistics, chords: piano.chords, noVocals: piano.noVocals,
  }));
  writeFileSync('.cache/listen/tune-pad-15s-cover.mid', notesToMidi(classic));
  const result = {
    input: stems.input,
    cacheSha256: Object.fromEntries(['.json', '-stems.json'].map(suffix =>
      [cache + suffix, createHash('sha256').update(readFileSync(cache + suffix)).digest('hex')])),
    caveat: 'The supplied generator uses sin(2*pi*f(t)*t), so its frequency modulation grows with elapsed time. Its 15 intended pitches are not stable ground-truth pitches. This check compares the actual Classic output on the unchanged clip.',
    classicNotes: classic.length, classicProminentNotes: reference.length,
    stemsNotes: piano.length, stemsMelodyNotes: actual.length,
    retainedClassicProminentAttacks: matches.filter(Boolean).length,
    classicMonophonicMelodySeconds: referenceTime, retainedMelodySeconds: preservedTime,
    retainedMelodyShare: preservedTime / referenceTime,
    noVocals: piano.noVocals, vocalMedianPitch: piano.vocalMedianPitch, fallbackUsed: piano.fallbackUsed,
    stats: statistics,
  };
  writeFileSync('.cache/run3/no-vocals-golden.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ classicNotes: result.classicNotes, stemsNotes: result.stemsNotes,
    classicProminentNotes: reference.length, stemsMelodyNotes: actual.length,
    retainedClassicProminentAttacks: result.retainedClassicProminentAttacks,
    retainedMelodyShare: result.retainedMelodyShare, noVocals: true, vocalMedianPitch: null }));
}
