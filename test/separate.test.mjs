import assert from 'node:assert/strict';
import { makeFFT } from '../fft.js';
import { K, stftChunk, istftChunk, separate, downmixToStereo, mono, decimate2 } from '../separate.js';
import { SR, extractMelody, melodyNotes } from '../melody.js';
import { decodeWav } from './separation-golden.mjs';

// Compare every output bin, including all 7680 bins, to a direct O(n^2) DFT.
for (const n of [1, 2, 3, 4, 5, 12, 30, 128, 7680]) {
  const re = Float64Array.from({ length: n }, (_, i) => Math.sin(i * 1.3) + (i % 7) / 7);
  const im = Float64Array.from({ length: n }, (_, i) => Math.cos(i * 0.7) - 0.5);
  const outRe = new Float64Array(n), outIm = new Float64Array(n);
  const cos = Float64Array.from({ length: n }, (_, i) => Math.cos(-2 * Math.PI * i / n));
  const sin = Float64Array.from({ length: n }, (_, i) => Math.sin(-2 * Math.PI * i / n));
  makeFFT(n)(re, im, outRe, outIm);
  let maximum = 0;
  for (let k = 0; k < n; k++) {
    let expectedRe = 0, expectedIm = 0;
    for (let j = 0; j < n; j++) {
      const at = (k * j) % n;
      expectedRe += re[j] * cos[at] - im[j] * sin[at];
      expectedIm += re[j] * sin[at] + im[j] * cos[at];
    }
    maximum = Math.max(maximum, Math.hypot(outRe[k] - expectedRe, outIm[k] - expectedIm));
  }
  assert.ok(maximum < 1e-9, `FFT n=${n}: max absolute DFT error ${maximum}`);
  if (n === 7680) console.log(`FFT n=7680, all bins vs naive DFT: max error ${maximum.toExponential(3)}`);
}
for (const n of [0, -1, 7, 2.5, Infinity]) assert.throws(() => makeFFT(n));

const length = K.GEN + K.STRIDE;
const signal = (frequency, phase = 0) => Float32Array.from({ length }, (_, i) => {
  // Smooth ends avoid a wide-band discontinuity from the chunk zero padding.
  const envelope = Math.sin(Math.PI / 2 * Math.min(1, i / 8192, (length - 1 - i) / 8192)) ** 2;
  return envelope * (0.3 * Math.sin(2 * Math.PI * frequency * i / K.SR + phase)
    + 0.1 * Math.sin(2 * Math.PI * 15000 * i / K.SR));
});
const left = signal(440), right = signal(697, 0.4);
const spectrum = stftChunk(left, right);
const restored = istftChunk(spectrum);
let stftError = 0;
for (let i = 0; i < K.GEN; i++) {
  stftError = Math.max(stftError, Math.abs(restored[0][i] - left[i]), Math.abs(restored[1][i] - right[i]));
}
assert.ok(stftError < 1e-5, `STFT/iSTFT band-limited error ${stftError}`);
const corruptedDc = spectrum.slice();
for (let t = 0; t < K.DIMT; t++) {
  corruptedDc[K.DIMF * K.DIMT + t] = 999;
  corruptedDc[3 * K.DIMF * K.DIMT + t] = -999;
}
assert.deepEqual(istftChunk(corruptedDc), restored, 'Imaginary DC must not affect inverse audio');

const progress = [];
const identity = await separate(left, right, async tensor => tensor, {
  onProgress: (completed, total) => progress.push([completed, total]),
});
assert.deepEqual(progress, [[1, 2], [2, 2]]);
let identityError = 0, reconstructionError = 0;
for (let side = 0; side < 2; side++) {
  const input = side ? right : left;
  for (let i = 0; i < length; i++) {
    identityError = Math.max(identityError, Math.abs(identity.vocals[side][i] / K.COMP - input[i]));
    reconstructionError = Math.max(reconstructionError,
      Math.abs(identity.vocals[side][i] + identity.instrumental[side][i] - input[i]));
  }
}
assert.ok(identityError < 1e-5, `Identity infer error ${identityError}`);
assert.ok(reconstructionError < 1e-6);
const zero = await separate(left.subarray(0, 8192), undefined, tensor => new Float32Array(tensor.length));
assert.equal(zero.vocals[0].some(value => value !== 0), false);
assert.deepEqual(zero.vocals[0], zero.vocals[1]);
assert.deepEqual(zero.instrumental[0], left.subarray(0, 8192));
assert.deepEqual(zero.instrumental[0], zero.instrumental[1]);
assert.equal((await separate(new Float32Array(), undefined, () => assert.fail())).chunks, 0);
await assert.rejects(separate([NaN], [0], x => x), /non-finite/);
await assert.rejects(separate([0], [0, 1], x => x), /equal-length/);
await assert.rejects(separate([0], [0], () => new Float32Array(4)), /invalid tensor/);
await assert.rejects(separate([0], [0], x => { x[0] = NaN; return x; }), /non-finite/);
console.log(`STFT identity max error ${stftError.toExponential(3)}; separate identity ${identityError.toExponential(3)}`);

const channel = (...values) => Float32Array.from(values);
assert.deepEqual(downmixToStereo([channel(1, 2)]), [channel(1, 2), channel(1, 2)]);
assert.deepEqual(downmixToStereo([channel(1), channel(2), channel(3), channel(6), channel(8)]),
  [channel(4), channel(4)]);
assert.deepEqual(mono(channel(1, -1), channel(-1, 1)), channel(0, 0));
assert.deepEqual(decimate2(channel()), channel());
assert.deepEqual(decimate2(new Float32Array(21).fill(0.5)), new Float32Array(11).fill(0.5));
const aliasTone = Float32Array.from({ length: 44100 }, (_, i) => Math.sin(2 * Math.PI * 15000 * i / 44100));
const filtered = decimate2(aliasTone);
assert.ok(Math.sqrt(filtered.subarray(20, filtered.length - 20).reduce((sum, value) => sum + value ** 2, 0)
  / (filtered.length - 40)) < 0.01, 'Decimation must suppress frequencies above the new Nyquist limit');

// The local golden loader is also checked in CI using generated bytes only.
for (const [format, bits] of [[1, 16], [3, 32]]) {
  const wav = Buffer.alloc(44 + 4 * bits / 8);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(format, 20); wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(44100, 24); wav.writeUInt32LE(44100 * 2 * bits / 8, 28);
  wav.writeUInt16LE(2 * bits / 8, 32); wav.writeUInt16LE(bits, 34);
  wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  for (const [i, value] of [0.5, -0.5, 0.25, -0.25].entries()) {
    if (format === 1) wav.writeInt16LE(value * 32768, 44 + 2 * i);
    else wav.writeFloatLE(value, 44 + 4 * i);
  }
  assert.deepEqual(decodeWav(wav), { sampleRate: 44100, channels: [channel(0.5, 0.25), channel(-0.5, -0.25)] });
}

// Three held pitches form a rising vocal-like sweep with 5.5 Hz vibrato.
// Harmonics and a smooth envelope exercise the actual salience/DP pipeline.
const held = [55, 59, 64], seconds = 2, gap = 0.25;
const vocal = new Float32Array(Math.ceil((held.length * (seconds + gap) + 0.5) * SR));
for (let note = 0; note < held.length; note++) {
  let phase = 0;
  const offset = Math.round((0.25 + note * (seconds + gap)) * SR);
  for (let i = 0; i < seconds * SR; i++) {
    const time = i / SR;
    const frequency = 440 * 2 ** ((held[note] - 69 + 0.28 * Math.sin(2 * Math.PI * 5.5 * time)) / 12);
    phase += 2 * Math.PI * frequency / SR;
    const envelope = Math.min(1, time / 0.08, (seconds - time) / 0.08);
    for (let harmonic = 1; harmonic <= 8; harmonic++) vocal[offset + i] += envelope * 0.14 / harmonic * Math.sin(harmonic * phase);
  }
}
const tracked = extractMelody(vocal);
assert.deepEqual(tracked.map(note => note.pitch), held, 'Vibrato must produce one note per held pitch');
assert.ok(tracked.every(note => note.end - note.start > 1.8));
const adapted = melodyNotes(vocal);
assert.deepEqual(adapted.map(note => note.pitchMidi), held);
assert.ok(adapted.every(note => note.amplitude >= 0 && note.amplitude <= 1 && note.durationSeconds > 1.8));
assert.deepEqual(extractMelody(new Float32Array()), []);
assert.deepEqual(extractMelody(new Float32Array(SR)), [], 'A silent stem must not invent a melody');
console.log('separation, downmix, decimation, and vocal melody tests passed');
