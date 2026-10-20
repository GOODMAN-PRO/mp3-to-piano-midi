import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { extractNotes } from '../extract.js';
import { pianoDefaults, defaultMaxSounding, toPianoNotes } from '../piano.js';
import { notesToMidi } from '../midi.js';

const root = resolve(import.meta.dirname, '..');
const directory = resolve(root, '.cache/classic-golden');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// Private song data and the pre-refactor MIDI bytes live only in ignored .cache.
// --extraction also repeats the slow Melodia extraction from the original frames.
export function runClassicGolden({ extraction = false } = {}) {
  const manifestPath = resolve(directory, 'manifest.json');
  if (!existsSync(manifestPath)) {
    console.log('SKIP classic golden: local .cache/classic-golden/manifest.json is absent.');
    return { skipped: true, songs: 0, midis: 0 };
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.songs.length, 7, 'Classic baseline must contain all seven cached songs');
  let songs = 0, midis = 0;
  for (const song of manifest.songs) {
    const cachePath = resolve(root, '.cache', song.cacheFile);
    const extractedPath = resolve(directory, song.extractedFile);
    const required = [cachePath, extractedPath,
      ...Object.values(song.presets).map(preset => resolve(directory, preset.file))];
    if (!required.every(existsSync)) {
      console.log(`SKIP classic golden ${song.name}: local cache or baseline files are absent.`);
      continue;
    }
    const cacheBytes = readFileSync(cachePath), extractedBytes = readFileSync(extractedPath);
    assert.equal(sha256(cacheBytes), song.cacheSha256, `${song.name}: inference fixture changed`);
    assert.equal(sha256(extractedBytes), song.extractedSha256, `${song.name}: extracted fixture changed`);
    const baseline = JSON.parse(extractedBytes);
    const cached = extraction ? JSON.parse(cacheBytes) : null;
    const notes = cached ? extractNotes(cached.frames, cached.onsets) : baseline;
    if (extraction) assert.deepEqual(notes, baseline, `${song.name}: classic extraction changed`);
    for (const preset of ['full', 'easy', 'cover']) {
      const expected = song.presets[preset], expectedBytes = readFileSync(resolve(directory, expected.file));
      assert.equal(sha256(expectedBytes), expected.sha256, `${song.name}/${preset}: golden MIDI changed`);
      const arranged = toPianoNotes(notes, { ...pianoDefaults, preset, maxSounding: defaultMaxSounding(preset) });
      const actual = Buffer.from(notesToMidi(arranged));
      assert.deepEqual(actual, expectedBytes, `${song.name}/${preset}: classic MIDI bytes changed`);
      midis++;
    }
    songs++;
    console.log(`Classic golden ${song.name}: full/easy/cover byte-identical${extraction ? ', extraction identical' : ''}.`);
  }
  console.log(`Classic goldens: ${midis} byte-identical MIDIs across ${songs} songs (baseline ${manifest.head}).`);
  return { skipped: songs === 0, songs, midis, extraction };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runClassicGolden({ extraction: process.argv.includes('--extraction') });
}
