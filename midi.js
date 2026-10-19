// Use the CommonJS entry explicitly: the package's named ESM export is unavailable in Node.
import midiPackage from '@tonejs/midi/build/Midi.js';

const { Midi } = midiPackage;

export function notesToMidi(pianoNotes, { splitHands = true } = {}) {
  const midi = new Midi();
  midi.header.setTempo(120);
  const tracks = (splitHands ? ['Left hand', 'Right hand'] : ['Piano']).map(name => {
    const track = midi.addTrack();
    track.name = name;
    track.instrument.number = 0;
    return track;
  });
  for (const { pitch, hand, startTimeSeconds, durationSeconds, velocity } of pianoNotes) {
    const right = hand === 'right' || hand !== 'left' && pitch >= 60;
    const track = tracks[splitHands && right ? 1 : 0];
    // Round start and end independently so touching same-pitch notes never overlap by a tick.
    const ticks = midi.header.secondsToTicks(startTimeSeconds);
    const durationTicks = Math.max(1, midi.header.secondsToTicks(startTimeSeconds + durationSeconds) - ticks);
    track.addNote({ midi: pitch, ticks, durationTicks, velocity });
  }
  return midi.toArray();
}
