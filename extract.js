import { noteFramesToTime, outputToNotesPoly } from '@spotify/basic-pitch';
import { pianoDefaults } from './piano.js';

export function extractNotes(frames, onsets, {
  onsetThresh = pianoDefaults.onsetThresh, frameThresh = pianoDefaults.frameThresh,
  minMs = pianoDefaults.minMs, energyTolerance = pianoDefaults.energyTolerance,
  melodiaTrick = true,
} = {}) {
  if (!frames.length) return [];
  // Missing onset data still has usable frame energy for Melodia continuations.
  if (!onsets || onsets.length !== frames.length || frames.some((row, i) =>
    !onsets[i] || onsets[i].length !== row.length || row.some((_, pitch) => !Number.isFinite(onsets[i][pitch])))) {
    onsets = frames.map((row, i) => row.map((_, pitch) =>
      Number.isFinite(onsets?.[i]?.[pitch]) ? onsets[i][pitch] : 0));
  }
  // Basic Pitch drops durationFrames <= minNoteLen, so subtract one from the desired frame count.
  const minNoteLen = Math.max(0, Math.ceil(minMs / 11.6099) - 1);
  const args = [frames, onsets, onsetThresh, frameThresh, minNoteLen, true, null, null];
  // Melodia notes are appended after onset notes. Count the latter to identify continuations exactly.
  const onsetFrames = outputToNotesPoly(...args, false, energyTolerance);
  const onsetCount = onsetFrames.length;
  const noteFrames = melodiaTrick ? outputToNotesPoly(...args, true, energyTolerance) : onsetFrames;
  return noteFramesToTime(noteFrames).map((note, index) => ({
    pitchMidi: note.pitchMidi,
    startTimeSeconds: note.startTimeSeconds,
    durationSeconds: note.durationSeconds,
    amplitude: note.amplitude,
    onset: index < onsetCount ? onsets[noteFrames[index].startFrame][note.pitchMidi - 21] : 0,
  }));
}
