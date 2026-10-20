// Use the CommonJS entry explicitly: the package's named ESM export is unavailable in Node.
import midiPackage from '@tonejs/midi/build/Midi.js';

const { Midi } = midiPackage;

export function notesToMidi(pianoNotes, { splitHands = true } = {}) {
  const midi = new Midi();
  const tempo = pianoNotes.estimatedBpm;
  midi.header.setTempo(Number.isFinite(tempo) && tempo >= 60 && tempo <= 180 ? tempo : 120);
  const tracks = (splitHands ? ['Left hand', 'Right hand'] : ['Piano']).map(name => {
    const track = midi.addTrack();
    track.name = name;
    track.instrument.number = 0;
    return track;
  });
  const quantized = [], previousByPitch = new Map();
  const valid = pianoNotes.filter(note => note && Number.isInteger(note.pitch) &&
    note.pitch >= 0 && note.pitch <= 127 && Number.isFinite(note.startTimeSeconds) &&
    note.startTimeSeconds >= 0 && Number.isFinite(note.durationSeconds) && note.durationSeconds > 0 &&
    Number.isFinite(note.startTimeSeconds + note.durationSeconds));
  for (const { pitch, hand, startTimeSeconds, durationSeconds, velocity } of
    valid.sort((a, b) => a.startTimeSeconds - b.startTimeSeconds)) {
    const ticks = midi.header.secondsToTicks(startTimeSeconds);
    const end = midi.header.secondsToTicks(startTimeSeconds + durationSeconds);
    if (!Number.isSafeInteger(ticks) || !Number.isSafeInteger(end)) continue;
    const safeVelocity = Number.isFinite(velocity) ? Math.min(1, Math.max(1 / 127, velocity)) : 0.7;
    const previous = previousByPitch.get(pitch);
    // Sub-tick re-strikes can round to one tick, even when assigned different hands.
    if (previous && previous.ticks === ticks) {
      previous.durationTicks = Math.max(previous.durationTicks, end - ticks);
      previous.velocity = Math.max(previous.velocity, safeVelocity);
      continue;
    }
    if (previous && previous.ticks + previous.durationTicks > ticks) previous.durationTicks = ticks - previous.ticks;
    const note = { pitch, hand, ticks, durationTicks: Math.max(1, end - ticks),
      velocity: safeVelocity };
    previousByPitch.set(pitch, note);
    quantized.push(note);
  }
  for (const { pitch, hand, ticks, durationTicks, velocity } of quantized) {
    const right = hand === 'right' || hand !== 'left' && pitch >= 60;
    const track = tracks[splitHands && right ? 1 : 0];
    track.addNote({ midi: pitch, ticks, durationTicks, velocity });
  }
  return midi.toArray();
}
