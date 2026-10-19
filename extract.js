import { noteFramesToTime, outputToNotesPoly } from '@spotify/basic-pitch';

export function extractNotes(frames, onsets, {
  onsetThresh = 0.5, frameThresh = 0.3, minMs = 80, energyTolerance = 11,
} = {}) {
  if (!frames.length) return [];
  // Basic Pitch drops durationFrames <= minNoteLen, so subtract one from the desired frame count.
  const minNoteLen = Math.max(0, Math.ceil(minMs / 11.6099) - 1);
  const args = [frames, onsets, onsetThresh, frameThresh, minNoteLen, true, null, null];
  // Melodia notes are appended after onset notes. Count the latter to identify continuations exactly.
  const onsetCount = outputToNotesPoly(...args, false, energyTolerance).length;
  const noteFrames = outputToNotesPoly(...args, true, energyTolerance);
  return noteFramesToTime(noteFrames).map((note, index) => ({
    pitchMidi: note.pitchMidi,
    startTimeSeconds: note.startTimeSeconds,
    durationSeconds: note.durationSeconds,
    amplitude: note.amplitude,
    onset: index < onsetCount ? onsets[noteFrames[index].startFrame][note.pitchMidi - 21] : 0,
  }));
}
