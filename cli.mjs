import { readFileSync, writeFileSync, statSync, mkdirSync, renameSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { BasicPitch } from '@spotify/basic-pitch';
import * as tf from '@tensorflow/tfjs';
import { extractNotes } from './extract.js';
import { toPianoNotes } from './piano.js';
import { notesToMidi } from './midi.js';

const root = dirname(fileURLToPath(import.meta.url));
export const defaults = { onset: 0.5, frame: 0.3, min: 80, poly: 6, tolerance: 11, legato: 0.65 };

export function noteStats(notes) {
  const sorted = [...notes].sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);
  const durations = sorted.map(n => n.durationSeconds * 1000).sort((a, b) => a - b);
  const previous = new Map();
  const events = [];
  let fragments = 0, onsetSum = 0, seconds = 0;
  for (const note of sorted) {
    const end = note.startTimeSeconds + note.durationSeconds;
    const last = previous.get(note.pitch);
    const gap = last ? note.startTimeSeconds - last.end : Infinity;
    if (gap >= -1e-9 && gap <= 0.05 + 1e-9) {
      fragments++;
      onsetSum += note.onset ?? 0;
    }
    previous.set(note.pitch, { end });
    seconds = Math.max(seconds, end);
    events.push([Math.round(note.startTimeSeconds * 1e9), 1], [Math.round(end * 1e9), -1]);
  }
  // End events precede starts at the same time: a re-strike is not an overlap.
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let sounding = 0, maxSoundingAtOnce = 0;
  for (const [, delta] of events) maxSoundingAtOnce = Math.max(maxSoundingAtOnce, sounding += delta);
  const mid = Math.floor(durations.length / 2);
  return {
    notes: notes.length,
    seconds,
    notesPerSec: seconds ? notes.length / seconds : 0,
    medianDurationMs: durations.length ? (durations[mid] + durations[Math.floor((durations.length - 1) / 2)]) / 2 : 0,
    pctUnder100ms: notes.length ? 100 * durations.filter(ms => ms < 100).length / notes.length : 0,
    fragments,
    meanOnsetAtFragmentStart: fragments ? onsetSum / fragments : 0,
    maxSoundingAtOnce,
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
    const flags = Object.entries(defaults).map(([key, value]) => `[--${key} ${value}]`).join(' ');
    console.log(`Usage: node cli.mjs <audio file> [--out file.mid] ${flags} [--no-split] [--json]`);
    return;
  }
  const input = resolve(args.shift());
  const options = { ...defaults };
  let output = join(dirname(input), `${basename(input, extname(input))}.mid`);
  let splitHands = true, json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--no-split') splitHands = false;
    else if (arg === '--json') json = true;
    else if (arg === '--out') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('--out needs a filename.');
      output = resolve(args[++i]);
    } else if (arg.startsWith('--') && Object.hasOwn(options, arg.slice(2))) {
      const key = arg.slice(2);
      const value = Number(args[++i]);
      if (!Number.isFinite(value)) throw new Error(`${arg} needs a finite number.`);
      options[key] = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  for (const key of ['onset', 'frame', 'legato']) {
    if (options[key] < 0 || options[key] > 1) throw new Error(`--${key} must be between 0 and 1.`);
  }
  for (const key of ['min', 'poly', 'tolerance']) {
    if (!Number.isInteger(options[key]) || options[key] < 1) throw new Error(`--${key} must be a positive integer.`);
  }
  if (options.poly > 10) throw new Error('--poly must be between 1 and 10.');
  if (output.toLowerCase() === input.toLowerCase()) throw new Error('Output must differ from the input audio file.');
  const { frames, onsets, cacheHit } = await modelOutput(input);
  const notes = extractNotes(frames, onsets, {
    onsetThresh: options.onset, frameThresh: options.frame, minMs: options.min, energyTolerance: options.tolerance,
  });
  const piano = toPianoNotes(notes, { maxPoly: options.poly, legato: options.legato });
  writeFileSync(output, notesToMidi(piano, { splitHands }));
  const stats = { input, output, cacheHit, parameters: { ...options, splitHands }, ...noteStats(piano) };
  if (json) console.log(JSON.stringify(stats));
  else {
    console.log(`Wrote ${output}`);
    for (const [key, value] of Object.entries(noteStats(piano))) console.log(`${key}: ${Number.isInteger(value) ? value : value.toFixed(3)}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
