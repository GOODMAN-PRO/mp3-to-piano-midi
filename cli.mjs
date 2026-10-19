import { readFileSync, writeFileSync, statSync, mkdirSync, renameSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { BasicPitch } from '@spotify/basic-pitch';
import * as tf from '@tensorflow/tfjs';
import { extractNotes } from './extract.js';
import { estimateKey, toPianoNotes } from './piano.js';
import { notesToMidi } from './midi.js';

const root = dirname(fileURLToPath(import.meta.url));
export const defaults = { onset: 0.5, frame: 0.3, min: 80, poly: 6, tolerance: 11, legato: 0.7, harmonic: 0.6, align: 30, ghost: 0.35, splitAt: 0, minSounding: 100, legatoGap: 0, maxSounding: 6, keyClean: 0.6, wobble: 0, melody: 3, preset: 'full' };

export function noteStats(notes) {
  const sorted = [...notes].sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);
  const durations = sorted.map(n => n.durationSeconds * 1000).sort((a, b) => a - b);
  const velocities = sorted.map(n => n.velocity).filter(Number.isFinite).sort((a, b) => a - b);
  const amplitudes = sorted.map(n => Number.isFinite(n.amplitude) ? n.amplitude : n.velocity);
  const percentile = (values, p) => {
    if (!values.length) return 0;
    const index = (values.length - 1) * p;
    const lo = Math.floor(index), hi = Math.ceil(index);
    return values[lo] + (values[hi] - values[lo]) * (index - lo);
  };
  let chordGroups = 0, chordSpread = 0, quietShortNotes = 0, firstLocal = 0, lastLocal = 0;
  const handOf = note => note.hand ?? (note.pitch >= 60 ? 'right' : 'left');
  let handSpanViolations = 0, handPolyViolations = 0;
  const handAttacks = { left: [], right: [] }, melody = [];
  for (let i = 0; i < sorted.length;) {
    let end = i + 1;
    while (end < sorted.length && sorted[end].startTimeSeconds <= sorted[i].startTimeSeconds + 0.03 + 1e-9) end++;
    if (end - i >= 2) {
      chordGroups++;
      chordSpread += (sorted[end - 1].startTimeSeconds - sorted[i].startTimeSeconds) * 1000;
    }
    const group = sorted.slice(i, end);
    const hands = ['left', 'right'].map(hand => group.filter(note => handOf(note) === hand).map(note => note.pitch));
    if (hands.some(pitches => pitches.length && Math.max(...pitches) - Math.min(...pitches) > 14)) handSpanViolations++;
    if (hands.some(pitches => pitches.length > 5)) handPolyViolations++;
    i = end;
  }
  for (const hand of ['left', 'right']) {
    const notes = sorted.filter(note => handOf(note) === hand);
    for (let i = 0; i < notes.length;) {
      let end = i + 1;
      while (end < notes.length && notes[end].startTimeSeconds <= notes[i].startTimeSeconds + 0.03 + 1e-9) end++;
      const pitches = [...new Set(notes.slice(i, end).map(note => note.pitch))];
      // A chord breaks a wobble run; its arbitrary pitch order is not a melody.
      handAttacks[hand].push({ start: notes[i].startTimeSeconds, pitch: pitches.length === 1 ? pitches[0] : null });
      if (hand === 'right') melody.push(Math.max(...pitches));
      i = end;
    }
  }
  for (let i = 0; i < sorted.length; i++) {
    const note = sorted[i];
    while (firstLocal < sorted.length && sorted[firstLocal].startTimeSeconds < note.startTimeSeconds - 1 - 1e-9) firstLocal++;
    while (lastLocal < sorted.length && sorted[lastLocal].startTimeSeconds <= note.startTimeSeconds + 1 + 1e-9) lastLocal++;
    if (note.durationSeconds >= 0.15 || !Number.isFinite(amplitudes[i])) continue;
    const local = amplitudes.slice(firstLocal, lastLocal).filter(Number.isFinite).sort((a, b) => a - b);
    if (amplitudes[i] < 0.35 * percentile(local, 0.5)) quietShortNotes++;
  }
  const previous = new Map();
  const nextPitch = new Map();
  let isolatedShortNotes = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const note = sorted[i];
    const end = note.startTimeSeconds + note.durationSeconds;
    const gap = (nextPitch.get(note.pitch) ?? Infinity) - end;
    if (note.durationSeconds < 0.12 - 1e-9 && !(gap >= -1e-9 && gap <= 0.12 + 1e-9)) isolatedShortNotes++;
    nextPitch.set(note.pitch, note.startTimeSeconds);
  }
  const previousHand = new Map();
  let sameHandGapsUnder100ms = 0;
  const events = [];
  let fragments = 0, onsetSum = 0, seconds = 0;
  let harmonicPairs = 0, harmonicPairsWeak = 0, firstSimultaneous = 0;
  for (const note of sorted) {
    const end = note.startTimeSeconds + note.durationSeconds;
    const last = previous.get(note.pitch);
    const gap = last ? note.startTimeSeconds - last.end : Infinity;
    if (gap >= -1e-9 && gap <= 0.05 + 1e-9) {
      fragments++;
      onsetSum += note.onset ?? 0;
    }
    previous.set(note.pitch, { end });
    const hand = handOf(note);
    const handGap = note.startTimeSeconds - (previousHand.get(hand) ?? Infinity);
    if (handGap >= 0.001 - 1e-9 && handGap <= 0.1 + 1e-9) sameHandGapsUnder100ms++;
    previousHand.set(hand, end);
    seconds = Math.max(seconds, end);
    events.push([Math.round(note.startTimeSeconds * 1e9), 1], [Math.round(end * 1e9), -1]);
    while (sorted[firstSimultaneous].startTimeSeconds < note.startTimeSeconds - 0.03 - 1e-9) firstSimultaneous++;
    let paired = false, weak = false;
    for (let i = firstSimultaneous; i < sorted.length && sorted[i].startTimeSeconds <= note.startTimeSeconds + 0.03 + 1e-9; i++) {
      const lower = sorted[i];
      if (![12, 19, 24].includes(note.pitch - lower.pitch)) continue;
      paired = true;
      if ((note.amplitude ?? note.velocity) < 0.6 * (lower.amplitude ?? lower.velocity)) weak = true;
    }
    if (paired) harmonicPairs++;
    if (weak) harmonicPairsWeak++;
  }
  // End events precede starts at the same time: a re-strike is not an overlap.
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let sounding = 0, maxSoundingAtOnce = 0, soundingTime = 0, crowdedTime = 0;
  let previousTime = events[0]?.[0] ?? 0;
  for (const [time, delta] of events) {
    soundingTime += sounding * (time - previousTime);
    if (sounding >= 5) crowdedTime += time - previousTime;
    maxSoundingAtOnce = Math.max(maxSoundingAtOnce, sounding += delta);
    previousTime = time;
  }
  const span = events.length ? events.at(-1)[0] - events[0][0] : 0;
  const key = estimateKey(sorted);
  let noteTime = 0, outOfKeyTime = 0, wobblePairs = 0, melodyJumps = 0;
  for (const note of sorted) {
    noteTime += note.durationSeconds;
    if (key && !key.scale.includes(note.pitch % 12)) outOfKeyTime += note.durationSeconds;
  }
  for (const attacks of Object.values(handAttacks)) {
    for (let i = 2; i < attacks.length; i++) {
      const [a, b, c] = attacks.slice(i - 2, i + 1);
      if ([a, b, c].every(note => note.pitch !== null) && a.pitch === c.pitch &&
        Math.abs(a.pitch - b.pitch) === 1 && b.start - a.start <= 0.15 + 1e-9 &&
        c.start - b.start <= 0.15 + 1e-9) wobblePairs++;
    }
  }
  for (let i = 1; i < melody.length; i++) if (Math.abs(melody[i] - melody[i - 1]) > 7) melodyJumps++;
  const mid = Math.floor(durations.length / 2);
  return {
    notes: notes.length,
    seconds,
    notesPerSec: seconds ? notes.length / seconds : 0,
    medianDurationMs: durations.length ? (durations[mid] + durations[Math.floor((durations.length - 1) / 2)]) / 2 : 0,
    durationP10: percentile(durations, 0.1),
    durationP50: percentile(durations, 0.5),
    durationP90: percentile(durations, 0.9),
    maxDurationMs: durations.at(-1) ?? 0,
    isolatedShortNotes,
    sameHandGapsUnder100ms,
    pctUnder100ms: notes.length ? 100 * durations.filter(ms => ms < 100 - 1e-6).length / notes.length : 0,
    fragments,
    harmonicPairs,
    harmonicPairsWeak,
    chordGroups,
    meanChordSpreadMs: chordGroups ? chordSpread / chordGroups : 0,
    velocityP5: percentile(velocities, 0.05),
    velocityP50: percentile(velocities, 0.5),
    velocityP95: percentile(velocities, 0.95),
    quietShortNotes,
    leftNotes: sorted.filter(note => handOf(note) === 'left').length,
    rightNotes: sorted.filter(note => handOf(note) === 'right').length,
    handSpanViolations,
    handPolyViolations,
    splitPoint: notes.splitPoint ?? 60,
    playabilityDrops: notes.playabilityDrops ?? 0,
    meanOnsetAtFragmentStart: fragments ? onsetSum / fragments : 0,
    maxSoundingAtOnce,
    keyEstimate: key?.name ?? null,
    outOfKeyPct: noteTime ? 100 * outOfKeyTime / noteTime : 0,
    meanSounding: span ? soundingTime / span : 0,
    pctTimeSounding5plus: span ? 100 * crowdedTime / span : 0,
    wobblePairs,
    melodyJumpRate: melody.length > 1 ? melodyJumps / (melody.length - 1) : 0,
  };
}

async function modelOutput(input) {
  const source = statSync(input);
  const modelPath = join(root, 'public/model/model.json');
  const modelStamp = statSync(modelPath).mtimeMs;
  const cacheDir = join(root, '.cache');
  const cachePath = join(cacheDir, `${basename(input)}-${source.size}.json`);
  try {
    const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
    if (cached.input === input && cached.mtimeMs === source.mtimeMs && cached.modelStamp === modelStamp) {
      console.error(`Using cached inference: ${basename(cachePath)}`);
      return { frames: cached.frames, onsets: cached.onsets, cacheHit: true };
    }
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }

  console.error('Decoding with ffmpeg…');
  const decoded = spawnSync('ffmpeg', ['-v', 'error', '-i', input, '-ac', '1', '-ar', '22050', '-f', 'f32le', '-'], {
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  });
  if (decoded.error?.code === 'ENOBUFS') throw new Error('Audio exceeds the 256 MiB decode limit (about 50 minutes). Split it into shorter files.');
  if (decoded.error) throw new Error(`ffmpeg failed (is it on PATH?): ${decoded.error.message}`);
  if (decoded.status !== 0) throw new Error(`ffmpeg failed: ${decoded.stderr.toString().trim()}`);
  if (!decoded.stdout.length || decoded.stdout.length % 4) throw new Error('ffmpeg returned no usable float32 audio.');
  // Buffer byteOffset is not necessarily aligned; own an aligned copy for Float32Array.
  const aligned = new Uint8Array(decoded.stdout.length);
  aligned.set(decoded.stdout);
  const audio = new Float32Array(aligned.buffer);
  await tf.setBackend('cpu');
  await tf.ready();
  const { modelTopology, weightsManifest, signature, format, generatedBy, convertedBy } = JSON.parse(readFileSync(modelPath, 'utf8'));
  const weights = Buffer.concat(weightsManifest.flatMap(group => group.paths.map(path => readFileSync(join(dirname(modelPath), path)))));
  const modelPromise = tf.loadGraphModel({ load: async () => ({
    modelTopology, signature, format, generatedBy, convertedBy,
    weightSpecs: weightsManifest.flatMap(group => group.weights),
    weightData: weights.buffer.slice(weights.byteOffset, weights.byteOffset + weights.byteLength),
  }) });
  const basicPitch = new BasicPitch(modelPromise);
  const model = await modelPromise;
  const frames = [], onsets = [];
  let lastPercent = -10;
  tf.engine().startScope();
  try {
    await basicPitch.evaluateModel(audio, (f, o) => { frames.push(...f); onsets.push(...o); }, progress => {
      const percent = Math.floor(progress * 100);
      if (percent >= lastPercent + 10 || percent === 100) {
        console.error(`Transcribing (${tf.getBackend()})… ${percent}%`);
        lastPercent = percent;
      }
    });
  } finally {
    tf.engine().endScope();
    model.dispose();
  }
  mkdirSync(cacheDir, { recursive: true });
  const temporary = `${cachePath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ input, mtimeMs: source.mtimeMs, modelStamp, frames, onsets }));
  renameSync(temporary, cachePath);
  return { frames, onsets, cacheHit: false };
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help')) {
    const flags = Object.entries(defaults).map(([key, value]) => `[--${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)} ${value}]`).join(' ');
    console.log(`Usage: node cli.mjs <audio file> [--out file.mid] ${flags} [--no-dynamics] [--no-split] [--json]`);
    console.log('--preset accepts full or easy; easy defaults to --max-sounding 5 unless supplied explicitly. Set --min-sounding 0 or --legato-gap 0 to disable length smoothing.');
    console.log('--max-sounding, --key-clean, --wobble and --melody accept 0 to disable their cleanup steps; --melody only affects Easy.');
    return;
  }
  const input = resolve(args.shift());
  const options = { ...defaults };
  let output = join(dirname(input), `${basename(input, extname(input))}.mid`);
  let splitHands = true, dynamics = true, json = false, maxSoundingSet = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const key = arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (arg === '--no-split') splitHands = false;
    else if (arg === '--no-dynamics') dynamics = false;
    else if (arg === '--json') json = true;
    else if (arg === '--out') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('--out needs a filename.');
      output = resolve(args[++i]);
    } else if (arg.startsWith('--') && Object.hasOwn(options, key)) {
      const value = key === 'preset' ? args[++i] : Number(args[++i]);
      if (key !== 'preset' && !Number.isFinite(value)) throw new Error(`${arg} needs a finite number.`);
      options[key] = value;
      if (key === 'maxSounding') maxSoundingSet = true;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  for (const key of ['onset', 'frame', 'legato', 'harmonic', 'ghost', 'keyClean']) {
    if (options[key] < 0 || options[key] > 1) throw new Error(`--${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)} must be between 0 and 1.`);
  }
  if (!['full', 'easy'].includes(options.preset)) throw new Error('--preset must be full or easy.');
  if (options.preset === 'easy' && !maxSoundingSet) options.maxSounding = 5;
  for (const key of ['align', 'minSounding', 'legatoGap', 'wobble']) {
    if (options[key] < 0) throw new Error(`--${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)} must be nonnegative.`);
  }
  if (!Number.isInteger(options.splitAt) || options.splitAt < 0 || options.splitAt > 127) throw new Error('--split-at must be 0 (automatic) or an integer MIDI pitch from 1 to 127.');
  for (const key of ['min', 'poly', 'tolerance']) {
    if (!Number.isInteger(options[key]) || options[key] < 1) throw new Error(`--${key} must be a positive integer.`);
  }
  if (options.poly > 10) throw new Error('--poly must be between 1 and 10.');
  if (!Number.isInteger(options.maxSounding) || options.maxSounding < 0 || options.maxSounding > 10) throw new Error('--max-sounding must be 0 (disabled) or an integer from 1 to 10.');
  if (options.melody < 0 || options.melody > 10) throw new Error('--melody must be between 0 and 10.');
  if (output.toLowerCase() === input.toLowerCase()) throw new Error('Output must differ from the input audio file.');
  const { frames, onsets, cacheHit } = await modelOutput(input);
  const notes = extractNotes(frames, onsets, {
    onsetThresh: options.onset, frameThresh: options.frame, minMs: options.min, energyTolerance: options.tolerance,
  });
  const piano = toPianoNotes(notes, {
    maxPoly: options.poly, legato: options.legato, harmonic: options.harmonic,
    align: options.align, ghost: options.ghost, dynamics, splitAt: options.splitAt,
    minSounding: options.minSounding, legatoGap: options.legatoGap, preset: options.preset,
    maxSounding: options.maxSounding, keyClean: options.keyClean, wobble: options.wobble, melody: options.melody,
  });
  writeFileSync(output, notesToMidi(piano, { splitHands }));
  const stats = { input, output, cacheHit, parameters: { ...options, dynamics, splitHands }, ...noteStats(piano) };
  if (json) console.log(JSON.stringify(stats));
  else {
    console.log(`Wrote ${output}`);
    for (const [key, value] of Object.entries(noteStats(piano))) console.log(`${key}: ${typeof value === 'number' ? Number.isInteger(value) ? value : value.toFixed(3) : value ?? 'none'}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
