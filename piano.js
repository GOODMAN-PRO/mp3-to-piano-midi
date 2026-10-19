export function toPianoNotes(notes, { maxPoly = 6 } = {}) {
  const sorted = notes.map(note => {
    let pitch = note.pitchMidi;
    while (pitch < 21) pitch += 12;
    while (pitch > 108) pitch -= 12;
    return {
      pitch,
      startTimeSeconds: note.startTimeSeconds,
      end: note.startTimeSeconds + note.durationSeconds,
      amplitude: note.amplitude,
    };
  }).sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);

  const merged = [];
  const previousByPitch = new Map();
  for (const note of sorted) {
    const previous = previousByPitch.get(note.pitch);
    // 1e-9 slack: back-to-back repeats of a pitch are not overlaps (float noise from frame math).
    if (previous && note.startTimeSeconds < previous.end - 1e-9) {
      previous.end = Math.max(previous.end, note.end);
      previous.amplitude = Math.max(previous.amplitude, note.amplitude);
    } else {
      merged.push(note);
      previousByPitch.set(note.pitch, note);
    }
  }

  const kept = [];
  for (let i = 0; i < merged.length;) {
    let end = i + 1;
    while (end < merged.length &&
      merged[end].startTimeSeconds - merged[i].startTimeSeconds <= 0.03) end++;
    const group = merged.slice(i, end);
    group.sort((a, b) => b.amplitude - a.amplitude);
    kept.push(...group.slice(0, maxPoly));
    i = end;
  }

  return kept.sort((a, b) => a.startTimeSeconds - b.startTimeSeconds).map(note => ({
    pitch: note.pitch,
    startTimeSeconds: note.startTimeSeconds,
    durationSeconds: note.end - note.startTimeSeconds,
    velocity: Math.min(1, Math.max(0.05, note.amplitude)),
  }));
}
