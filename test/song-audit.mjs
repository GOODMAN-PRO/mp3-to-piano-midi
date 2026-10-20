import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import midiPackage from '@tonejs/midi/build/Midi.js';

// Audit exported MIDI, where rounding and cross-track note-off ordering matter.
export function auditMidi(bytes) {
  const midi = new midiPackage.Midi(bytes);
  const notes = midi.tracks.flatMap((track, trackIndex) => track.notes.map(note => ({
    pitch: note.midi, tick: note.ticks, endTick: note.ticks + note.durationTicks,
    time: note.time, track: trackIndex,
    hand: /left/i.test(track.name) ? 'left' : /right/i.test(track.name) ? 'right'
      : note.midi < 60 ? 'left' : 'right',
  }))).sort((a, b) => a.tick - b.tick || a.track - b.track);
  const result = {
    tracks: midi.tracks.length, notes: notes.length,
    samePitchOverlapsWithinTracks: 0, samePitchOverlapsAcrossTracks: 0,
    zeroLength: 0, crossHandSameTickHazards: 0,
    handSpanViolations: 0, handPolyViolations: 0,
    maxHandSpan: 0, maxNotesPerHandGroup: 0,
  };
  const byPitch = new Map();
  for (const note of notes) {
    if (note.endTick <= note.tick) result.zeroLength++;
    if (!byPitch.has(note.pitch)) byPitch.set(note.pitch, []);
    const earlier = byPitch.get(note.pitch);
    // Keep touching endings here: a same-tick handoff is unsafe across MIDI tracks.
    for (let i = earlier.length - 1; i >= 0; i--) {
      const previous = earlier[i];
      if (previous.endTick < note.tick) {
        earlier.splice(i, 1);
        continue;
      }
      if (previous.endTick > note.tick) {
        result[previous.track === note.track ? 'samePitchOverlapsWithinTracks'
          : 'samePitchOverlapsAcrossTracks']++;
      }
      if (previous.hand !== note.hand && (previous.tick === note.tick || previous.endTick === note.tick)) {
        result.crossHandSameTickHazards++;
      }
    }
    earlier.push(note);
  }
  for (const hand of ['left', 'right']) {
    const line = notes.filter(note => note.hand === hand);
    for (let i = 0; i < line.length;) {
      let end = i + 1;
      while (end < line.length && line[end].time - line[i].time <= 0.03 + 1e-9) end++;
      const pitches = line.slice(i, end).map(note => note.pitch);
      const span = Math.max(...pitches) - Math.min(...pitches);
      if (span > 14) result.handSpanViolations++;
      if (pitches.length > 5) result.handPolyViolations++;
      result.maxHandSpan = Math.max(result.maxHandSpan, span);
      result.maxNotesPerHandGroup = Math.max(result.maxNotesPerHandGroup, pitches.length);
      i = end;
    }
  }
  result.pass = ['samePitchOverlapsWithinTracks', 'samePitchOverlapsAcrossTracks', 'zeroLength',
    'crossHandSameTickHazards', 'handSpanViolations', 'handPolyViolations'].every(key => result[key] === 0);
  return result;
}

export function runSongAudit(directory = resolve(import.meta.dirname, '../.cache/listen')) {
  if (!existsSync(directory)) {
    console.log('SKIP listening MIDI audit: local .cache/listen directory is absent.');
    return [];
  }
  const files = readdirSync(directory).filter(file => /-(stems|cover)\.mid$/i.test(file)).sort();
  if (!files.length) console.log('SKIP listening MIDI audit: no local stems/cover MIDI pairs found.');
  const results = files.map(file => ({ file, ...auditMidi(readFileSync(resolve(directory, file))) }));
  for (const result of results) console.log(JSON.stringify(result));
  assert.ok(results.every(result => result.pass), 'Listening MIDI invariant audit failed; see per-file counts.');
  console.log(`Listening MIDI audit: ${results.length} files passed.`);
  return results;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) runSongAudit();
