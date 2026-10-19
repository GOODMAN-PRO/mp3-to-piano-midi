export function toPianoNotes(notes, { maxPoly = 6, legato = 0.65, harmonic = 0.6 } = {}) {
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

  const ghosts = new Set();
  if (harmonic > 0) {
    let firstNear = 0;
    for (const note of merged) {
      while (merged[firstNear].startTimeSeconds < note.startTimeSeconds - 0.03 - 1e-9) firstNear++;
      for (let i = firstNear; i < merged.length && merged[i].startTimeSeconds <= note.startTimeSeconds + 0.03 + 1e-9; i++) {
        const lower = merged[i];
        if (![12, 19, 24].includes(note.pitch - lower.pitch) || !(note.amplitude < harmonic * lower.amplitude)) continue;
        const overlap = Math.min(note.end, lower.end) - Math.max(note.startTimeSeconds, lower.startTimeSeconds);
        if (overlap >= 0.6 * (note.end - note.startTimeSeconds) - 1e-9) {
          ghosts.add(note);
          break;
        }
      }
    }
  }

  const kept = [];
  for (let i = 0; i < merged.length;) {
    let end = i + 1;
    while (end < merged.length &&
      merged[end].startTimeSeconds - merged[i].startTimeSeconds <= 0.03) end++;
    // Keep the original chord-group anchors, removing ghosts before they use a cap slot.
    const group = merged.slice(i, end).filter(note => !ghosts.has(note));
    group.sort((a, b) => b.amplitude - a.amplitude);
    kept.push(...group.slice(0, maxPoly));
    i = end;
  }

  return kept.sort((a, b) => a.startTimeSeconds - b.startTimeSeconds).map(note => ({
    pitch: note.pitch,
    startTimeSeconds: note.startTimeSeconds,
    durationSeconds: note.end - note.startTimeSeconds,
    amplitude: note.amplitude,
    velocity: Math.min(1, Math.max(0.05, note.amplitude)),
    ...(note.onset === undefined ? {} : { onset: note.onset }),
  }));
}
