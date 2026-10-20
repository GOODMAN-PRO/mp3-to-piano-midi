import { makeFFT } from './fft.js';

export const K = Object.freeze({
  SR: 44100, NFFT: 7680, HOP: 1024, DIMF: 3072, DIMT: 256,
  CHUNK: 261120, TRIM: 3840, GEN: 253440, OVL: 63360, STRIDE: 190080, COMP: 1.009,
  INPUT_SHAPE: Object.freeze([1, 4, 3072, 256]),
});
const { NFFT, HOP, DIMF, DIMT, CHUNK, TRIM, GEN, OVL, STRIDE, COMP } = K;
const tensorLength = 4 * DIMF * DIMT;
const fft = makeFFT(NFFT);
const win = Float64Array.from({ length: NFFT }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / NFFT));
const envelope = new Float64Array(CHUNK + NFFT);
for (let t = 0; t < DIMT; t++) {
  for (let j = 0; j < NFFT; j++) envelope[t * HOP + j] += win[j] * win[j];
}
const re = new Float64Array(NFFT), im = new Float64Array(NFFT);
const outRe = new Float64Array(NFFT), outIm = new Float64Array(NFFT);
const weight = new Float32Array(GEN).fill(1);
for (let i = 0; i < OVL; i++) {
  const ramp = (i + 1) / (OVL + 1);
  weight[i] = ramp;
  weight[GEN - 1 - i] = ramp;
}

// Virtual signal: TRIM zeros, then the mix, then zeros. Reflect padding belongs
// to each CHUNK-sized segment, not to the whole recording.
export function stftChunk(L, R = L, offset = 0, output = new Float32Array(tensorLength)) {
  const sample = (channel, j) => {
    const index = offset + j - TRIM;
    return index >= 0 && index < channel.length ? channel[index] : 0;
  };
  for (let t = 0; t < DIMT; t++) {
    const start = t * HOP - NFFT / 2;
    for (let j = 0; j < NFFT; j++) {
      const at = start + j;
      const reflected = at < 0 ? -at : at >= CHUNK ? 2 * (CHUNK - 1) - at : at;
      re[j] = sample(L, reflected) * win[j];
      im[j] = sample(R, reflected) * win[j];
    }
    // Two real channels share one complex FFT.
    fft(re, im, outRe, outIm);
    for (let k = 0; k < DIMF; k++) {
      const mirror = (NFFT - k) % NFFT;
      const a = outRe[k], b = outIm[k], c = outRe[mirror], d = outIm[mirror];
      output[k * DIMT + t] = 0.5 * (a + c);
      output[(DIMF + k) * DIMT + t] = 0.5 * (b - d);
      output[(2 * DIMF + k) * DIMT + t] = 0.5 * (b + d);
      output[(3 * DIMF + k) * DIMT + t] = 0.5 * (c - a);
    }
  }
  return output;
}

export function istftChunk(spectrum, L = new Float64Array(GEN), R = new Float64Array(GEN)) {
  const left = new Float64Array(CHUNK + NFFT), right = new Float64Array(CHUNK + NFFT);
  for (let t = 0; t < DIMT; t++) {
    re.fill(0);
    im.fill(0);
    for (let k = 0; k < DIMF; k++) {
      const lr = spectrum[k * DIMT + t], li = k === 0 ? 0 : spectrum[(DIMF + k) * DIMT + t];
      const rr = spectrum[(2 * DIMF + k) * DIMT + t], ri = k === 0 ? 0 : spectrum[(3 * DIMF + k) * DIMT + t];
      re[k] = lr - ri;
      im[k] = li + rr;
      if (k > 0) {
        re[NFFT - k] = lr + ri;
        im[NFFT - k] = rr - li;
      }
    }
    // Swapping real/imaginary arguments performs the inverse. Bins >= DIMF
    // stay zero; the imaginary DC components are explicitly discarded above.
    fft(im, re, outRe, outIm);
    for (let j = 0; j < NFFT; j++) {
      left[t * HOP + j] += win[j] * outIm[j] / NFFT;
      right[t * HOP + j] += win[j] * outRe[j] / NFFT;
    }
  }
  for (let i = 0; i < GEN; i++) {
    const at = TRIM + NFFT / 2 + i;
    L[i] = left[at] / envelope[at];
    R[i] = right[at] / envelope[at];
  }
  return [L, R];
}

// infer accepts a Float32Array in [1,4,3072,256] layout and returns the same
// layout, synchronously or asynchronously. Runtime/session ownership is external.
export async function separate(L, R = L, infer, { onProgress } = {}) {
  if (!L || !R || L.length !== R.length) throw new Error('Separation needs equal-length stereo channels.');
  if (typeof infer !== 'function') throw new Error('Separation needs an inference function.');
  for (let i = 0; i < L.length; i++) {
    if (!Number.isFinite(L[i]) || !Number.isFinite(R[i])) throw new Error('Separation input contains non-finite samples.');
  }
  const started = performance.now(), length = L.length;
  const chunks = length ? Math.ceil(Math.max(length - GEN, 0) / STRIDE) + 1 : 0;
  const accL = new Float32Array(chunks ? (chunks - 1) * STRIDE + GEN : 0);
  const accR = new Float32Array(accL.length), weights = new Float32Array(accL.length);
  const input = new Float32Array(tensorLength), pieceL = new Float64Array(GEN), pieceR = new Float64Array(GEN);
  const timings = { stft: 0, infer: 0, istft: 0, total: 0 };
  for (let chunk = 0; chunk < chunks; chunk++) {
    const offset = chunk * STRIDE, start = performance.now();
    stftChunk(L, R, offset, input);
    const forwardEnd = performance.now();
    const prediction = await infer(input);
    const inferenceEnd = performance.now();
    if (!(prediction instanceof Float32Array) || prediction.length !== tensorLength) {
      throw new Error(`Separation model returned an invalid tensor for chunk ${chunk + 1}.`);
    }
    for (let j = 0; j < prediction.length; j++) {
      if (!Number.isFinite(prediction[j])) throw new Error(`Separation model returned a non-finite value in chunk ${chunk + 1}.`);
    }
    istftChunk(prediction, pieceL, pieceR);
    timings.stft += (forwardEnd - start) / 1000;
    timings.infer += (inferenceEnd - forwardEnd) / 1000;
    timings.istft += (performance.now() - inferenceEnd) / 1000;
    // Float32 overlap-add, including ramps on the first and last chunk edges.
    for (let i = 0; i < GEN; i++) {
      accL[offset + i] += pieceL[i] * weight[i];
      accR[offset + i] += pieceR[i] * weight[i];
      weights[offset + i] += weight[i];
    }
    onProgress?.(chunk + 1, chunks);
  }
  const vocals = [new Float32Array(length), new Float32Array(length)];
  const instrumental = [new Float32Array(length), new Float32Array(length)];
  for (let i = 0; i < length; i++) {
    const divisor = Math.max(weights[i], 1e-8);
    // Round the un-compensated estimate to fp32, matching the Python reference.
    vocals[0][i] = Math.fround(accL[i] / divisor) * COMP;
    vocals[1][i] = Math.fround(accR[i] / divisor) * COMP;
    instrumental[0][i] = L[i] - vocals[0][i];
    instrumental[1][i] = R[i] - vocals[1][i];
  }
  timings.total = (performance.now() - started) / 1000;
  return { vocals, instrumental, chunks, timings };
}

// Mono is duplicated. For >2 channels, average even-indexed channels into L
// and odd-indexed channels into R. This also defines the future browser path.
export function downmixToStereo(channels) {
  if (!channels.length) return [new Float32Array(), new Float32Array()];
  const length = channels[0].length;
  if (channels.some(channel => channel.length !== length)) throw new Error('Audio channels must have equal lengths.');
  if (channels.length === 1) return [Float32Array.from(channels[0]), Float32Array.from(channels[0])];
  const stereo = [new Float32Array(length), new Float32Array(length)];
  const counts = [Math.ceil(channels.length / 2), Math.floor(channels.length / 2)];
  for (let channel = 0; channel < channels.length; channel++) {
    const side = channel % 2;
    for (let i = 0; i < length; i++) stereo[side][i] += channels[channel][i] / counts[side];
  }
  return stereo;
}

export function mono(L, R = L) {
  if (L.length !== R.length) throw new Error('Audio channels must have equal lengths.');
  return Float32Array.from(L, (value, i) => (value + R[i]) / 2);
}

const halfBand = Float64Array.from({ length: 31 }, (_, i) => {
  const n = i - 15;
  const sinc = n === 0 ? 0.5 : Math.sin(Math.PI * n / 2) / (Math.PI * n);
  return sinc * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / 30));
});
const filterSum = halfBand.reduce((sum, value) => sum + value, 0);
for (let i = 0; i < halfBand.length; i++) halfBand[i] /= filterSum;

// Delay-compensated, 31-tap windowed-sinc half-band filter, 44.1 -> 22.05 kHz.
export function decimate2(input) {
  const output = new Float32Array(Math.ceil(input.length / 2));
  if (!input.length) return output;
  for (let i = 0; i < output.length; i++) {
    let sample = 0;
    for (let tap = 0; tap < halfBand.length; tap++) {
      const at = Math.max(0, Math.min(input.length - 1, 2 * i + tap - 15));
      sample += input[at] * halfBand[tap];
    }
    output[i] = sample;
  }
  return output;
}
