export function toPianoNotes(notes, { maxPoly = 6, legato = 0.65 } = {}) {
  const sorted = notes.map(note => {
    let pitch = note.pitchMidi;
    while (pitch < 21) pitch += 12;
    while (pitch > 108) pitch -= 12;
    return {
      pitch,
      startTimeSeconds: note.startTimeSeconds,
      end: note.startTimeSeconds + note.durationSeconds,
      amplitude: note.amplitude,
      onset: note.onset,
    };
  }).sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);

  const merged = [];
  const previousByPitch = new Map();
  for (const note of sorted) {
    const previous = previousByPitch.get(note.pitch);
    // Preserve real re-strikes; join weak fragments across gaps of at most 80 ms.
    // The slack avoids treating frame-math noise as an overlap or an oversized gap.
    const overlaps = previous && note.startTimeSeconds < previous.end - 1e-9;
    const fragment = previous && legato > 0 && Number.isFinite(note.onset) &&
      note.onset < legato && note.startTimeSeconds - previous.end <= 0.08 + 1e-9;
    if (overlaps || fragment) {
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
    ...(note.onset === undefined ? {} : { onset: note.onset }),
  }));
}
