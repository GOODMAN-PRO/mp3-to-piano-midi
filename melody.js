// Vocal stem -> monophonic melody at its original register. No runtime dependency.
// The tracker keeps its symmetric Hann; separation uses a periodic Hann.
//
// input : mono Float32Array at 22050 Hz (the vocal stem, channels averaged, resampled)
// output: [{pitch, start, end, vel}]  (pitch = MIDI integer, start/end seconds), monophonic, sorted
//
export const SR = 22050;

export const DEFAULTS = {
  // front end: harmonic-sum salience
  N: 4096, hop: 256, fminMidi: 40, fmaxMidi: 86, bps: 4, nHarm: 10, decay: 0.82, whiten: 61, percentile: 99.5, clip: 1.5,
  // F0 Viterbi (voiced bins + one unvoiced state)
  theta: 0.65, lam: 0.3, mu: 1.5, eps: 1e-3,
  // note DP (integer semitone states + REST)
  cap: 1.5, kappa: 0.5, rho: 1.3, gamma: 4.4, gamma2: 0.15, gammaRest: 2.7,
  qLo: 0.18, qHi: 0.6, floorDb: -47, lo: 36, hi: 96,
  // post-processing
  minMs: 120, splitDb: 6, splitMinMs: 140, gapFillMs: 100, gapLeaveMs: 15, outlierSt: 7,
  tuning: 0,   // semitones; subtract a global detune estimate before rounding (0 = off)
};

// ---------------------------------------------------------------- FFT (radix-2, in place)
function makeFFT(n) {
  const levels = Math.log2(n) | 0;
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = Math.sin(2 * Math.PI * i / n); }
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b); rev[i] = r; }
  return function fft(re, im) {   // forward transform, e^{-i...}
    for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const tr = re[l] * cos[k] + im[l] * sin[k];
          const ti = -re[l] * sin[k] + im[l] * cos[k];
          re[l] = re[j] - tr; im[l] = im[j] - ti; re[j] += tr; im[j] += ti;
        }
      }
    }
  };
}

// numpy-style linear-interpolated percentile of a Float32Array (sorts a copy)
function percentile(arr, p) {
  const s = Float32Array.from(arr).sort();
  const pos = (s.length - 1) * p / 100, lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

function reflectPad(x, before, after) {
  const n = x.length, out = new Float32Array(n + before + after);
  out.set(x, before);
  for (let i = 0; i < before; i++) out[before - 1 - i] = x[Math.min(i + 1, n - 1)];
  for (let i = 0; i < after; i++) out[before + n + i] = x[Math.max(n - 2 - i, 0)];
  return out;
}

// ---------------------------------------------------------------- 1. harmonic-sum salience map
export function salienceMap(x, o = DEFAULTS) {
  const { N, hop, fminMidi, fmaxMidi, bps, nHarm, decay, whiten } = o;
  const xp = reflectPad(x, N / 2, N / 2 + hop);
  const T = 1 + Math.floor((xp.length - N) / hop);
  const K = Math.floor((fmaxMidi - fminMidi) * bps) + 1;
  const binMidi = new Float64Array(K);
  for (let k = 0; k < K; k++) binMidi[k] = fminMidi + k / bps;
  const half = N / 2;
  // harmonic bin lookup: for pitch k and harmonic h -> FFT bin (or -1)
  const hb = new Int32Array(K * nHarm).fill(-1), hw = new Float64Array(nHarm);
  for (let h = 1; h <= nHarm; h++) hw[h - 1] = Math.pow(decay, h - 1);
  for (let k = 0; k < K; k++) {
    const f0 = 440 * Math.pow(2, (binMidi[k] - 69) / 12);
    for (let h = 1; h <= nHarm; h++) {
      const b = f0 * h * N / SR;
      if (b < half - 2) hb[k * nHarm + h - 1] = Math.min(Math.max(Math.round(b), 0), half);
    }
  }
  const win = new Float64Array(N);                     // numpy.hanning (symmetric)
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
  const fft = makeFFT(N);
  const sal = new Float32Array(T * K);
  const re = new Float64Array(N), im = new Float64Array(N);
  const mag = [new Float64Array(half + 1), new Float64Array(half + 1)];
  const cum = new Float64Array(half + 2), w = new Float64Array(half + 1), wmax = new Float64Array(half + 1);
  const wr = whiten >> 1;
  for (let t0 = 0; t0 < T; t0 += 2) {
    const two = t0 + 1 < T;
    for (let i = 0; i < N; i++) {                      // pack two real frames into one complex FFT
      re[i] = xp[t0 * hop + i] * win[i];
      im[i] = two ? xp[(t0 + 1) * hop + i] * win[i] : 0;
    }
    fft(re, im);
    for (let k = 0; k <= half; k++) {
      const k2 = (N - k) & (N - 1);
      const ar = 0.5 * (re[k] + re[k2]), ai = 0.5 * (im[k] - im[k2]);
      const br = 0.5 * (im[k] + im[k2]), bi = -0.5 * (re[k] - re[k2]);
      mag[0][k] = Math.sqrt(Math.hypot(ar, ai));       // sqrt-compressed magnitude
      mag[1][k] = Math.sqrt(Math.hypot(br, bi));
    }
    for (let f = 0; f < (two ? 2 : 1); f++) {
      const m = mag[f];
      cum[0] = 0; for (let k = 0; k <= half; k++) cum[k + 1] = cum[k] + m[k];
      for (let k = 0; k <= half; k++) {                // whitening: subtract moving average (edge-replicated)
        const a = k - wr, b = k + wr;
        let s = cum[Math.min(b, half) + 1] - cum[Math.max(a, 0)];
        if (a < 0) s += -a * m[0];
        if (b > half) s += (b - half) * m[half];
        const v = m[k] - s / whiten;
        w[k] = v > 0 ? v : 0;
      }
      for (let k = 0; k <= half; k++) {                // 3-bin max filter
        let v = w[k]; if (k > 0 && w[k - 1] > v) v = w[k - 1]; if (k < half && w[k + 1] > v) v = w[k + 1]; wmax[k] = v;
      }
      const row = (t0 + f) * K;
      for (let k = 0; k < K; k++) {
        let s = 0;
        for (let h = 0; h < nHarm; h++) { const b = hb[k * nHarm + h]; if (b >= 0) s += hw[h] * wmax[b]; }
        sal[row + k] = s;
      }
    }
  }
  return { sal, T, K, binMidi };
}

// ---------------------------------------------------------------- 2. voiced/unvoiced Viterbi over the map
export function decodeF0(sal, T, K, binMidi, o = DEFAULTS) {
  const norm = percentile(sal, o.percentile);
  if (!(norm > 0)) return { midi: new Float64Array(T).fill(NaN), conf: new Float64Array(T) };
  const P = new Float32Array(T * K);
  for (let i = 0; i < sal.length; i++) { const v = sal[i] / norm; P[i] = v < o.clip ? v : o.clip; }
  const step = binMidi[1] - binMidi[0], lam = o.lam * step, mu = o.mu, eps = o.eps;
  const logU = Math.log(o.theta + eps);
  const logE = (t, k) => Math.log(Math.max(P[t * K + k], 0) + eps);
  let cv = new Float64Array(K), ncv = new Float64Array(K), d = new Float64Array(K);
  const idx = new Int32Array(K), back = new Int16Array(T * (K + 1));
  for (let k = 0; k < K; k++) cv[k] = -logE(0, k);
  let cu = -logU;
  for (let t = 1; t < T; t++) {
    for (let k = 0; k < K; k++) { d[k] = cv[k]; idx[k] = k; }
    for (let k = 1; k < K; k++) if (d[k - 1] + lam < d[k]) { d[k] = d[k - 1] + lam; idx[k] = idx[k - 1]; }
    for (let k = K - 2; k >= 0; k--) if (d[k + 1] + lam < d[k]) { d[k] = d[k + 1] + lam; idx[k] = idx[k + 1]; }
    let bj = 0, bv = cv[0];
    for (let k = 1; k < K; k++) if (cv[k] < bv) { bv = cv[k]; bj = k; }
    const base = t * (K + 1);
    for (let k = 0; k < K; k++) {
      let c = d[k], p = idx[k];
      if (cu + mu < c) { c = cu + mu; p = K; }
      ncv[k] = c - logE(t, k); back[base + k] = p;
    }
    let ncu;
    if (bv + mu < cu) { ncu = bv + mu; back[base + K] = bj; } else { ncu = cu; back[base + K] = K; }
    ncu -= logU;
    const tmp = cv; cv = ncv; ncv = tmp; cu = ncu;
  }
  const path = new Int32Array(T);
  let s = K, best = cu;
  for (let k = 0; k < K; k++) if (cv[k] < best) { best = cv[k]; s = k; }
  for (let t = T - 1; t >= 0; t--) { path[t] = s < K ? s : -1; if (t > 0) s = back[t * (K + 1) + s]; }
  const midi = new Float64Array(T).fill(NaN), conf = new Float64Array(T);
  for (let t = 0; t < T; t++) {
    const k = path[t]; if (k < 0) continue;
    const a = Math.max(0, k - 2), b = Math.min(K, k + 3);
    let sw = 0, sm = 0;
    for (let j = a; j < b; j++) { const w = P[t * K + j]; sw += w; sm += w * binMidi[j]; }
    midi[t] = sm / Math.max(sw, 1e-9); conf[t] = P[t * K + k];
  }
  return { midi, conf };
}

// ---------------------------------------------------------------- 3. frame energy (dB)
export function rmsDb(x, o = DEFAULTS, T) {
  const win = 1024, pad = 512, hop = o.hop, out = new Float64Array(T);
  for (let t = 0; t < T; t++) {
    let s = 0;
    for (let i = 0; i < win; i++) { const j = t * hop + i - pad; if (j >= 0 && j < x.length) s += x[j] * x[j]; }
    out[t] = 10 * Math.log10(s / win + 1e-12);
  }
  return out;
}

// ---------------------------------------------------------------- 4. F0 track -> notes
export function notesFromTrack(midi, conf, rms, hopS, o = DEFAULTS) {
  const T = midi.length, S = o.hi - o.lo + 1;
  const sorted = Float64Array.from(rms).sort();
  const pos = (sorted.length - 1) * 0.98, lo98 = Math.floor(pos), hi98 = Math.ceil(pos);
  const ref98 = sorted[lo98] + (sorted[hi98] - sorted[lo98]) * (pos - lo98);
  const q = new Float64Array(T), p = new Float64Array(T);
  for (let t = 0; t < T; t++) {
    if (Number.isFinite(midi[t])) {
      let v = (conf[t] - o.qLo) / (o.qHi - o.qLo); v = v < 0 ? 0 : v > 1 ? 1 : v;
      q[t] = rms[t] > ref98 + o.floorDb ? v : 0;
      p[t] = midi[t] - o.tuning;
    }
  }
  // Viterbi over semitone states 0..S-1 and REST (= S)
  let cost = new Float64Array(S + 1), nc = new Float64Array(S + 1);
  const back = new Int16Array(T * (S + 1)), d = new Float64Array(S), idx = new Int16Array(S);
  const dev = (t, s) => { const v = Math.abs(p[t] - (o.lo + s)); return v > o.cap ? o.cap : v; };
  for (let s = 0; s < S; s++) cost[s] = q[0] * dev(0, s) + (1 - q[0]) * o.kappa;
  cost[S] = q[0] * o.rho;
  for (let t = 1; t < T; t++) {
    for (let s = 0; s < S; s++) { d[s] = cost[s]; idx[s] = s; }
    for (let s = 1; s < S; s++) if (d[s - 1] + o.gamma2 < d[s]) { d[s] = d[s - 1] + o.gamma2; idx[s] = idx[s - 1]; }
    for (let s = S - 2; s >= 0; s--) if (d[s + 1] + o.gamma2 < d[s]) { d[s] = d[s + 1] + o.gamma2; idx[s] = idx[s + 1]; }
    let bj = 0, bv = cost[0];
    for (let s = 1; s < S; s++) if (cost[s] < bv) { bv = cost[s]; bj = s; }
    const base = t * (S + 1);
    for (let s = 0; s < S; s++) {
      let c = cost[s], b = s;
      if (d[s] + o.gamma < c) { c = d[s] + o.gamma; b = idx[s]; }
      if (cost[S] + o.gammaRest < c) { c = cost[S] + o.gammaRest; b = S; }
      nc[s] = c + q[t] * dev(t, s) + (1 - q[t]) * o.kappa; back[base + s] = b;
    }
    let c = cost[S], b = S;
    if (bv + o.gammaRest < c) { c = bv + o.gammaRest; b = bj; }
    nc[S] = c + q[t] * o.rho; back[base + S] = b;
    const tmp = cost; cost = nc; nc = tmp;
  }
  const st = new Int16Array(T);
  let s = 0;
  for (let k = 1; k <= S; k++) if (cost[k] < cost[s]) s = k;
  for (let t = T - 1; t >= 0; t--) { st[t] = s; if (t > 0) s = back[t * (S + 1) + s]; }
  // runs of one state, trimmed to voiced frames
  const runs = [];
  let a = 0;
  for (let t = 1; t <= T; t++) {
    if (t === T || st[t] !== st[a]) {
      if (st[a] !== S) {
        let f = a, l = t - 1;
        while (f < t && !(q[f] > 0.3)) f++;
        while (l >= a && !(q[l] > 0.3)) l--;
        if (f <= l) runs.push([f, l + 1, o.lo + st[a]]);
      }
      a = t;
    }
  }
  // energy-dip re-attack split
  const e = new Float64Array(T);
  for (let t = 0; t < T; t++) {        // 3-point mean, zero padded like numpy 'same'
    e[t] = ((t > 0 ? rms[t - 1] : 0) + rms[t] + (t < T - 1 ? rms[t + 1] : 0)) / 3;
  }
  const minF = Math.ceil(o.minMs / 1000 / hopS - 1e-6), smin = Math.ceil(o.splitMinMs / 1000 / hopS - 1e-6);
  const w8 = Math.round(0.09 / hopS);
  const pieces = [];
  for (const [ra, rb, pit] of runs) {
    const cuts = [ra];
    if (rb - ra >= 2 * smin) {
      for (let m = ra + smin; m < rb - smin; m++) {
        if (e[m] <= e[m - 1] && e[m] < e[m + 1] + 1e-9) {
          let left = -Infinity, right = -Infinity;
          for (let j = Math.max(ra, m - w8); j <= m; j++) left = Math.max(left, e[j]);
          for (let j = m; j <= Math.min(rb, m + w8) && j < T; j++) right = Math.max(right, e[j]);
          if (Math.min(left, right) - e[m] >= o.splitDb && m - cuts[cuts.length - 1] >= smin) cuts.push(m);
        }
      }
    }
    cuts.push(rb);
    for (let i = 0; i < cuts.length - 1; i++) pieces.push([cuts[i], cuts[i + 1], pit]);
  }
  const notes = [];
  for (const [fa, fb, pit] of pieces) {
    if (fb - fa < minF) continue;
    const seg = Array.from(rms.subarray(fa, fb)).sort((x, y) => x - y);
    const med = seg.length % 2 ? seg[(seg.length - 1) >> 1] : 0.5 * (seg[seg.length / 2 - 1] + seg[seg.length / 2]);
    const vel = Math.min(110, Math.max(35, Math.round(45 + (med - (ref98 - 24)) * 2.2)));
    notes.push({ pitch: pit, start: fa * hopS, end: fb * hopS, vel });
  }
  // isolated outlier: a short note far from both neighbours (each within 1 s) is a tracking glitch
  if (o.outlierSt > 0) {
    const keep = [];
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      const dp = i > 0 && n.start - notes[i - 1].end < 1 ? Math.abs(n.pitch - notes[i - 1].pitch) : null;
      const dn = i + 1 < notes.length && notes[i + 1].start - n.end < 1 ? Math.abs(n.pitch - notes[i + 1].pitch) : null;
      const far = (dp === null || dp > o.outlierSt) && (dn === null || dn > o.outlierSt);
      if (!((dp !== null || dn !== null) && far && n.end - n.start < 0.5)) keep.push(n);
    }
    notes.length = 0; notes.push(...keep);
  }
  // legato: close small gaps, keep a tiny gap so repeated pitches re-strike
  const leave = o.gapLeaveMs / 1000;
  for (let i = 0; i + 1 < notes.length; i++) {
    const A = notes[i], B = notes[i + 1], gap = B.start - A.end;
    if (gap > leave && gap <= o.gapFillMs / 1000) A.end = B.start - leave;
    else if (gap < leave && A.pitch === B.pitch) A.end = Math.max(A.start + 0.05, B.start - leave);
  }
  return notes;
}

// ---------------------------------------------------------------- full pipeline
export function extractMelody(x, opts = {}) {
  if (!x.length) return [];
  const o = { ...DEFAULTS, ...opts };
  const { sal, T, K, binMidi } = salienceMap(x, o);
  const { midi, conf } = decodeF0(sal, T, K, binMidi, o);
  const rms = rmsDb(x, o, T);
  return notesFromTrack(midi, conf, rms, o.hop / SR, o);
}

// Adapt the frozen tracker's velocity range to the shared arrangement input.
export function melodyNotes(x, opts = {}) {
  return extractMelody(x, opts).map(({ pitch, start, end, vel }) => ({
    pitchMidi: pitch,
    startTimeSeconds: start,
    durationSeconds: end - start,
    amplitude: (vel - 35) / 75,
  }));
}
