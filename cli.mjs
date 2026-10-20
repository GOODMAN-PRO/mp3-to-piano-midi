import { readFileSync, writeFileSync, statSync, mkdirSync, renameSync, existsSync, copyFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { BasicPitch } from '@spotify/basic-pitch';
import * as tf from '@tensorflow/tfjs';
import { extractNotes } from './extract.js';
import { estimateKey, pianoDefaults, defaultMaxSounding, toPianoNotes } from './piano.js';
import { notesToMidi } from './midi.js';

const root = dirname(fileURLToPath(import.meta.url));
const { onsetThresh, frameThresh, minMs, energyTolerance, maxPoly, ...arrangementDefaults } = pianoDefaults;
export const defaults = {
  ...arrangementDefaults, onset: onsetThresh, frame: frameThresh, min: minMs,
  tolerance: energyTolerance, poly: maxPoly, maxSounding: defaultMaxSounding(pianoDefaults.preset),
};

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
  const labelled = sorted.some(note => note.role);
  const melodyNotes = labelled ? sorted.filter(note => note.role === 'melody') : [];
  // Classic has no roles. Preserve its historical highest-RH estimate, and label that estimate.
  if (!labelled) {
    const right = sorted.filter(note => handOf(note) === 'right');
    for (let i = 0; i < right.length;) {
      let end = i + 1;
      while (end < right.length && right[end].startTimeSeconds <= right[i].startTimeSeconds + 0.03 + 1e-9) end++;
      melodyNotes.push(right.slice(i, end).reduce((a, b) => b.pitch > a.pitch ? b : a));
      i = end;
    }
  }
  const accompaniment = labelled ? sorted.filter(note => note.role !== 'melody')
    : sorted.filter(note => handOf(note) === 'left');
  const melodyTime = melodyNotes.reduce((sum, note) => sum + note.durationSeconds, 0);
  const melodyLeftTime = melodyNotes.filter(note => handOf(note) === 'left')
    .reduce((sum, note) => sum + note.durationSeconds, 0);
  let roleJumps = 0, clashTime = 0;
  for (let i = 0; i < melodyNotes.length; i++) {
    const note = melodyNotes[i];
    if (i && Math.abs(note.pitch - melodyNotes[i - 1].pitch) > 7) roleJumps++;
    const intervals = accompaniment.filter(other => {
      const distance = Math.abs(note.pitch - other.pitch);
      return distance <= 14 && [1, 11].includes(distance % 12);
    }).map(other => [Math.max(note.startTimeSeconds, other.startTimeSeconds),
      Math.min(note.startTimeSeconds + note.durationSeconds, other.startTimeSeconds + other.durationSeconds)])
      .filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0]);
    let lastEnd = -Infinity;
    for (const [start, end] of intervals) {
      clashTime += Math.max(0, end - Math.max(start, lastEnd));
      lastEnd = Math.max(lastEnd, end);
    }
  }
  const perHand = {};
  for (const hand of ['left', 'right']) {
    const held = sorted.filter(note => handOf(note) === hand);
    const backing = accompaniment.filter(note => handOf(note) === hand);
    const attacks = [];
    for (const note of backing) if (!attacks.length || note.startTimeSeconds > attacks.at(-1) + 0.03 + 1e-9) {
      attacks.push(note.startTimeSeconds);
    }
    let maxAttacks = 0, first = 0, count = 0, maximum = 0;
    for (let i = 0; i < attacks.length; i++) {
      while (attacks[i] - attacks[first] > 1 + 1e-9) first++;
      maxAttacks = Math.max(maxAttacks, i - first + 1);
    }
    const handEvents = held.flatMap(note => [[Math.round(note.startTimeSeconds * 1e9), 1],
      [Math.round((note.startTimeSeconds + note.durationSeconds) * 1e9), -1]])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (const [, delta] of handEvents) maximum = Math.max(maximum, count += delta);
    perHand[hand] = {
      accompanimentAttacksPerSec: seconds ? attacks.length / seconds : 0,
      maxAccompanimentAttacksIn1s: maxAttacks,
      meanSounding: span ? held.reduce((sum, note) => sum + note.durationSeconds, 0) / (span / 1e9) : 0,
      maxSounding: maximum,
    };
  }
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
    pctUnder120ms: notes.length ? 100 * durations.filter(ms => ms < 120 - 1e-6).length / notes.length : 0,
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
    melodyJumpRate: melodyNotes.length > 1 ? roleJumps / (melodyNotes.length - 1) : 0,
    melodyNotesPerSec: seconds ? melodyNotes.length / seconds : 0,
    melodyLeftShare: melodyTime ? melodyLeftTime / melodyTime : 0,
    melodyMetricSource: labelled ? 'role' : 'highest-right-hand-estimate',
    vocalMedianPitch: notes.vocalMedianPitch ?? null,
    accompanimentAttacksPerSec: perHand.left.accompanimentAttacksPerSec + perHand.right.accompanimentAttacksPerSec,
    perHand,
    clashPct: melodyTime ? 100 * clashTime / melodyTime : 0,
    estimatedBpm: notes.estimatedBpm ?? 120,
    gridDeviationMs: notes.gridDeviationMs ?? 0,
    tempoConfidence: notes.tempoConfidence ?? 0,
    phaseConfidence: notes.phaseConfidence ?? 0,
    quantized: notes.quantized ?? false,
    quantizedNotes: notes.quantizedNotes ?? 0,
    timingOffsetSeconds: notes.timingOffsetSeconds ?? 0,
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
  const { frames, onsets } = await transcribeAudio(audio);
  mkdirSync(cacheDir, { recursive: true });
  const temporary = `${cachePath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ input, mtimeMs: source.mtimeMs, modelStamp, frames, onsets }));
  renameSync(temporary, cachePath);
  return { frames, onsets, cacheHit: false };
}

async function transcribeAudio(audio) {
  const modelPath = join(root, 'public/model/model.json');
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
  return { frames, onsets };
}

const separationModel = {
  name: 'Kim_Vocal_2.onnx',
  sha256: 'ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b',
  url: 'https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/Kim_Vocal_2.onnx',
};
export const stemsDefaults = { theta: 0.65, splitDb: 6, lhGroove: 0.6, rhLegato: 350 };
const secondsSince = start => (performance.now() - start) / 1000;
const hash = data => createHash('sha256').update(data).digest('hex');

async function ensureSeparationModel() {
  const path = join(root, '.cache/models', separationModel.name);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    if (hash(readFileSync(path)) !== separationModel.sha256) {
      throw new Error(`SHA-256 mismatch in ${path}; remove the corrupt cache file and retry.`);
    }
    return path;
  }
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    const local = join('G:/Temp/sep-research/downloads/kim_vocal_2', separationModel.name);
    if (existsSync(local)) copyFileSync(local, temporary);
    else {
      console.error('Downloading Kim_Vocal_2 (67 MB)…');
      const response = await fetch(separationModel.url);
      if (!response.ok) throw new Error(`Model download failed: HTTP ${response.status}`);
      writeFileSync(temporary, new Uint8Array(await response.arrayBuffer()));
    }
    if (hash(readFileSync(temporary)) !== separationModel.sha256) throw new Error('Downloaded separation model failed SHA-256 verification.');
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  return path;
}

// Float32 WAV avoids clipping stems whose peaks exceed 1.0.
function writeStem(path, channels) {
  const size = channels[0].length * 8, buffer = Buffer.allocUnsafe(44 + size);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + size, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(3, 20); buffer.writeUInt16LE(2, 22);
  buffer.writeUInt32LE(44100, 24); buffer.writeUInt32LE(44100 * 8, 28);
  buffer.writeUInt16LE(8, 32); buffer.writeUInt16LE(32, 34); buffer.write('data', 36);
  buffer.writeUInt32LE(size, 40);
  for (let i = 0; i < channels[0].length; i++) {
    buffer.writeFloatLE(channels[0][i], 44 + i * 8);
    buffer.writeFloatLE(channels[1][i], 48 + i * 8);
  }
  writeFileSync(path, buffer);
}

function decodeStereo(input) {
  const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=channels', '-of', 'csv=p=0', input], { windowsHide: true });
  if (probe.error || probe.status !== 0) throw new Error(`ffprobe failed: ${probe.error?.message ?? probe.stderr.toString().trim()}`);
  const channels = Number(probe.stdout.toString().trim());
  if (!Number.isInteger(channels) || channels < 1) throw new Error('No usable audio stream.');
  const args = ['-v', 'error', '-i', input, '-map', '0:a:0'];
  if (channels === 1) args.push('-af', 'pan=stereo|c0=c0|c1=c0');
  else if (channels > 2) {
    const side = parity => {
      const indexes = Array.from({ length: channels }, (_, i) => i).filter(i => i % 2 === parity);
      return indexes.map(i => `${1 / indexes.length}*c${i}`).join('+');
    };
    args.push('-af', `pan=stereo|c0=${side(0)}|c1=${side(1)}`);
  }
  args.push('-ac', '2', '-ar', '44100', '-f', 'f32le', '-');
  const decoded = spawnSync('ffmpeg', args, { maxBuffer: 512 * 1024 * 1024, windowsHide: true });
  if (decoded.error?.code === 'ENOBUFS') throw new Error('Audio exceeds the 512 MiB stereo decode limit (about 25 minutes). Split it into shorter files.');
  if (decoded.error) throw new Error(`ffmpeg failed: ${decoded.error.message}`);
  if (decoded.status !== 0) throw new Error(`ffmpeg failed: ${decoded.stderr.toString().trim()}`);
  if (!decoded.stdout.length || decoded.stdout.length % 8) throw new Error('ffmpeg returned no usable stereo float32 audio.');
  const count = decoded.stdout.length / 8, L = new Float32Array(count), R = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    L[i] = decoded.stdout.readFloatLE(i * 8); R[i] = decoded.stdout.readFloatLE(i * 8 + 4);
  }
  return [L, R];
}

async function stemsOutput(input, options) {
  const { separate, mono, decimate2, K } = await import('./separate.js');
  const { melodyNotes } = await import('./melody.js');
  const source = statSync(input), modelStamp = statSync(join(root, 'public/model/model.json')).mtimeMs;
  const cacheDir = join(root, '.cache'), cachePath = join(cacheDir, `${basename(input)}-${source.size}-stems.json`);
  const vocalPath = cachePath.replace(/\.json$/, '-vocals.f32');
  const targetStems = options.keepStems ? ['vocals.wav', 'instrumental.wav']
    .map(name => resolve(options.keepStems, name)) : null;
  if (targetStems?.some(path => path.toLowerCase() === input.toLowerCase())) {
    throw new Error('--keep-stems must not overwrite the input audio. Choose a different directory.');
  }
  // Arrangement/extraction settings do not invalidate expensive neural inference.
  const pipelineHash = hash(Buffer.concat(['fft.js', 'separate.js', 'melody.js']
    .map(file => readFileSync(join(root, file)))));
  let cached;
  try {
    cached = JSON.parse(readFileSync(cachePath, 'utf8'));
    if (cached.input !== input || cached.mtimeMs !== source.mtimeMs || cached.modelStamp !== modelStamp ||
      cached.pipelineHash !== pipelineHash || cached.modelHash !== separationModel.sha256) cached = undefined;
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  const timings = { decode: 0, separation: 0, melody: 0, basicPitch: 0 };
  let vocal22, instrumental22, stemPaths = cached?.stemPaths, stemHashes = cached?.stemHashes, provider = cached?.provider;
  const tuned = options.theta !== stemsDefaults.theta || options.splitDb !== stemsDefaults.splitDb;
  const keepAvailable = options.keepStems && stemPaths?.every((path, i) =>
    existsSync(path) && stemHashes?.[i] === hash(readFileSync(path)));
  if (!cached || options.keepStems && !keepAvailable || tuned && !existsSync(vocalPath)) {
    let ort;
    try { ort = await import('onnxruntime-node'); }
    catch (error) { throw new Error(`Stems mode needs optional onnxruntime-node@1.30.0. Install it with npm i --cache G:\\Temp\\npm-cache -O onnxruntime-node@1.30.0, or use --classic. ${error.message}`); }
    const modelPath = await ensureSeparationModel();
    let start = performance.now();
    console.error('Decoding stereo with ffmpeg…');
    const [L, R] = decodeStereo(input);
    timings.decode = secondsSince(start);
    const createSession = ep => ort.InferenceSession.create(modelPath, {
      executionProviders: [ep], graphOptimizationLevel: 'all',
      ...(ep === 'cpu' ? { intraOpNumThreads: 8 } : {}),
    });
    provider = options.ep ?? (process.platform === 'win32' ? 'dml' : 'cpu');
    let session;
    start = performance.now();
    console.error(`Loading separation model (${provider})…`);
    try {
      try { session = await createSession(provider); }
      catch (error) {
        if (provider !== 'dml') throw error;
        console.error(`DirectML setup failed; retrying on CPU: ${error.message}`);
        provider = 'cpu'; session = await createSession(provider);
      }
      let lastPercent = -10;
      const infer = async data => {
        try {
          const output = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', data, K.INPUT_SHAPE) });
          const prediction = output[session.outputNames[0]].data;
          if (!(prediction instanceof Float32Array) || prediction.length !== data.length ||
            prediction.some(value => !Number.isFinite(value))) throw new Error('Invalid separation tensor.');
          return prediction;
        } catch (error) {
          if (provider !== 'dml') throw error;
          console.error(`DirectML inference failed; retrying on CPU: ${error.message}`);
          await session.release();
          provider = 'cpu'; session = await createSession(provider);
          const output = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', data, K.INPUT_SHAPE) });
          return output[session.outputNames[0]].data;
        }
      };
      const stems = await separate(L, R, infer, { onProgress: (completed, total) => {
        const percent = Math.floor(completed / total * 100);
        if (percent >= lastPercent + 10 || percent === 100) {
          console.error(`Separating vocals (${provider})… ${percent}%`); lastPercent = percent;
        }
      } });
      timings.separation = secondsSince(start);
      timings.separationParts = stems.timings;
      vocal22 = decimate2(mono(...stems.vocals));
      if (!cached) instrumental22 = decimate2(mono(...stems.instrumental));
      if (options.keepStems) {
        mkdirSync(options.keepStems, { recursive: true });
        stemPaths = targetStems;
        writeStem(stemPaths[0], stems.vocals); writeStem(stemPaths[1], stems.instrumental);
        stemHashes = stemPaths.map(path => hash(readFileSync(path)));
      }
    } finally { if (session) await session.release(); }
  }
  if (options.keepStems && keepAvailable) {
    mkdirSync(options.keepStems, { recursive: true });
    stemPaths.forEach(path => {
      const target = join(options.keepStems, basename(path));
      if (resolve(path).toLowerCase() !== resolve(target).toLowerCase()) copyFileSync(path, target);
    });
    stemPaths = targetStems;
  }
  let melody = cached?.melody;
  if (!cached || tuned) {
    const start = performance.now();
    if (!vocal22) {
      const data = readFileSync(vocalPath);
      vocal22 = new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    }
    melody = melodyNotes(vocal22, { theta: options.theta, splitDb: options.splitDb });
    timings.melody = secondsSince(start);
  }
  let frames = cached?.frames, onsets = cached?.onsets;
  if (!cached) {
    const start = performance.now();
    ({ frames, onsets } = await transcribeAudio(instrumental22));
    timings.basicPitch = secondsSince(start);
    mkdirSync(cacheDir, { recursive: true });
    // Keep the frozen-default melody in the inference cache, even after a tuned first run.
    const defaultMelody = tuned ? melodyNotes(vocal22) : melody;
    const record = { input, mtimeMs: source.mtimeMs, modelStamp, pipelineHash, modelHash: separationModel.sha256,
      melody: defaultMelody, frames, onsets, duration: instrumental22.length / 22050, provider, stemPaths, stemHashes, timings };
    const temporary = `${cachePath}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(record)); renameSync(temporary, cachePath);
  } else if (options.keepStems && (JSON.stringify(cached.stemPaths) !== JSON.stringify(stemPaths) ||
    JSON.stringify(cached.stemHashes) !== JSON.stringify(stemHashes))) {
    const temporary = `${cachePath}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ ...cached, stemPaths, stemHashes }));
    renameSync(temporary, cachePath);
  }
  if (vocal22) writeFileSync(vocalPath, new Uint8Array(vocal22.buffer, vocal22.byteOffset, vocal22.byteLength));
  if (cached) console.error(`Using cached stem inference: ${basename(cachePath)}`);
  return { frames, onsets, melody, duration: cached?.duration ?? instrumental22.length / 22050,
    provider, cacheHit: Boolean(cached), timings, inferenceTimings: cached?.timings ?? timings };
}

export async function convertFile(input, options = {}) {
  input = resolve(input);
  const maxSoundingSet = options.maxSounding !== undefined;
  options = { ...defaults, ...stemsDefaults, ...options };
  if (!maxSoundingSet) options.maxSounding = defaultMaxSounding(options.preset);
  const start = performance.now();
  const data = options.classic ? await modelOutput(input) : await stemsOutput(input, options);
  const extractionStart = performance.now();
  const notes = extractNotes(data.frames, data.onsets, {
    onsetThresh: options.onset, frameThresh: options.frame, minMs: options.min,
    energyTolerance: options.tolerance, melodiaTrick: Boolean(options.classic),
  });
  const extraction = secondsSince(extractionStart), arrangementStart = performance.now();
  const piano = options.classic ? toPianoNotes(notes, { ...options, maxPoly: options.poly })
    : (await import('./stems.js')).arrangeStems(data.melody, notes, { ...options, durationSeconds: data.duration });
  const timings = { ...data.timings, extraction, arrangement: secondsSince(arrangementStart), total: secondsSince(start) };
  return { piano, midi: notesToMidi(piano, { splitHands: options.splitHands !== false }),
    stats: { input, mode: options.classic ? 'classic' : 'stems', cacheHit: data.cacheHit,
      provider: data.provider, timings, inferenceTimings: data.inferenceTimings,
      parameters: options, ...noteStats(piano) } };
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help')) {
    const flags = Object.entries(defaults).filter(([, value]) => typeof value !== 'boolean').map(([key, value]) => `[--${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)} ${value}]`).join(' ');
    console.log(`Usage: node cli.mjs <audio file> [--classic] [--ep dml|cpu] [--keep-stems dir] [--out file.mid] ${flags} [--no-dynamics] [--no-split] [--no-quantize] [--json]`);
    console.log('Default: separate vocals for the melody in its natural register; arrange instrumental backing in the other hand. --classic keeps the full-mix pipeline.');
    console.log('Stems controls: --theta 0.65 --split-db 6 --lh-groove 0.6 --rh-legato 350 (ms). --chords-only disables pulses.');
    console.log(`--preset accepts full, easy or cover; their --max-sounding defaults are ${['full', 'easy', 'cover'].map(defaultMaxSounding).join(', ')}. Set --min-sounding 0 or --legato-gap 0 to disable length smoothing.`);
    console.log('--max-sounding, --key-clean and --wobble accept 0 to disable their cleanup steps; --melody 0 restores highest-note selection in Easy/Cover. Quantization skips short clips and weak tempo estimates.');
    return;
  }
  const input = resolve(args.shift());
  const options = { ...defaults, ...stemsDefaults };
  let output = join(dirname(input), `${basename(input, extname(input))}.mid`);
  let splitHands = true, json = false, maxSoundingSet = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const key = arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (arg === '--no-split') splitHands = false;
    else if (arg === '--classic') options.classic = true;
    else if (arg === '--chords-only') options.chordsOnly = true;
    else if (arg === '--ep' || arg === '--keep-stems') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${arg} needs a value.`);
      options[key] = arg === '--keep-stems' ? resolve(args[++i]) : args[++i];
    }
    else if (arg === '--no-dynamics') options.dynamics = false;
    else if (arg === '--no-quantize') options.quantize = false;
    else if (arg === '--json') json = true;
    else if (arg === '--out') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('--out needs a filename.');
      output = resolve(args[++i]);
    } else if (arg.startsWith('--') && typeof options[key] !== 'boolean' && Object.hasOwn(options, key)) {
      const value = key === 'preset' ? args[++i] : Number(args[++i]);
      if (key !== 'preset' && !Number.isFinite(value)) throw new Error(`${arg} needs a finite number.`);
      options[key] = value;
      if (key === 'maxSounding') maxSoundingSet = true;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  for (const key of ['onset', 'frame', 'legato', 'harmonic', 'ghost', 'keyClean']) {
    if (options[key] < 0 || options[key] > 1) throw new Error(`--${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)} must be between 0 and 1.`);
  }
  if (!['full', 'easy', 'cover'].includes(options.preset)) throw new Error('--preset must be full, easy or cover.');
  if (!maxSoundingSet) options.maxSounding = defaultMaxSounding(options.preset);
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
  if (options.ep && !['dml', 'cpu'].includes(options.ep)) throw new Error('--ep must be dml or cpu.');
  for (const key of ['theta', 'splitDb', 'lhGroove', 'rhLegato']) {
    if (options[key] < 0) throw new Error(`--${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)} must be nonnegative.`);
  }
  if (output.toLowerCase() === input.toLowerCase()) throw new Error('Output must differ from the input audio file.');
  const { piano, midi, stats: result } = await convertFile(input, { ...options, splitHands });
  writeFileSync(output, midi);
  const stats = { ...result, output };
  if (json) console.log(JSON.stringify(stats));
  else {
    console.log(`Wrote ${output}`);
    for (const [key, value] of Object.entries(noteStats(piano))) console.log(`${key}: ${typeof value === 'number' ? Number.isInteger(value) ? value : value.toFixed(3) : value ?? 'none'}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
