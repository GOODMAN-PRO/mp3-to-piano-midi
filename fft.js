// Mixed-radix (4,2,3,5) complex FFT with precomputed twiddles.
export function makeFFT(N) {
  if (!Number.isSafeInteger(N) || N < 1) throw new Error('FFT size must be a positive integer.');
  const factors = []; let n = N;
  for (const p of [5, 3]) while (n % p === 0) { factors.push(p); n /= p; }
  while (n % 4 === 0) { factors.push(4); n /= 4; }
  if (n % 2 === 0) { factors.push(2); n /= 2; }
  if (n !== 1) throw new Error('size ' + N + ' not 2^a3^b5^c');
  const wr = new Float64Array(N), wi = new Float64Array(N);
  for (let j = 0; j < N; j++) { wr[j] = Math.cos(2 * Math.PI * j / N); wi[j] = -Math.sin(2 * Math.PI * j / N); }
  const c1 = Math.cos(2 * Math.PI / 5), c2 = Math.cos(4 * Math.PI / 5), s1 = Math.sin(2 * Math.PI / 5), s2 = Math.sin(4 * Math.PI / 5), h3 = Math.sqrt(3) / 2;
  const yr = new Float64Array(N), yi = new Float64Array(N);
  function rec(xr, xi, xo, xs, n, yo, fi) {
    if (n === 1) { yr[yo] = xr[xo]; yi[yo] = xi[xo]; return; }
    const p = factors[fi], m = n / p;
    for (let q = 0; q < p; q++) rec(xr, xi, xo + q * xs, xs * p, m, yo + q * m, fi + 1);
    const tw = N / n;
    if (p === 2) {
      for (let k = 0; k < m; k++) {
        const a = yo + k, b = a + m, t = k * tw, br = yr[b] * wr[t] - yi[b] * wi[t], bi = yr[b] * wi[t] + yi[b] * wr[t];
        const ar = yr[a], ai = yi[a]; yr[a] = ar + br; yi[a] = ai + bi; yr[b] = ar - br; yi[b] = ai - bi;
      }
    } else if (p === 4) {
      for (let k = 0; k < m; k++) {
        const i0 = yo + k, i1 = i0 + m, i2 = i1 + m, i3 = i2 + m, t1 = k * tw, t2 = 2 * t1, t3 = 3 * t1;
        const r0 = yr[i0], q0 = yi[i0];
        const r1 = yr[i1] * wr[t1] - yi[i1] * wi[t1], q1 = yr[i1] * wi[t1] + yi[i1] * wr[t1];
        const r2 = yr[i2] * wr[t2] - yi[i2] * wi[t2], q2 = yr[i2] * wi[t2] + yi[i2] * wr[t2];
        const r3 = yr[i3] * wr[t3] - yi[i3] * wi[t3], q3 = yr[i3] * wi[t3] + yi[i3] * wr[t3];
        const sr = r0 + r2, si = q0 + q2, dr = r0 - r2, di = q0 - q2, ur = r1 + r3, ui = q1 + q3, vr = r1 - r3, vi = q1 - q3;
        yr[i0] = sr + ur; yi[i0] = si + ui; yr[i2] = sr - ur; yi[i2] = si - ui;
        yr[i1] = dr + vi; yi[i1] = di - vr; yr[i3] = dr - vi; yi[i3] = di + vr;
      }
    } else if (p === 3) {
      for (let k = 0; k < m; k++) {
        const i0 = yo + k, i1 = i0 + m, i2 = i1 + m, t1 = k * tw, t2 = 2 * t1;
        const r0 = yr[i0], q0 = yi[i0];
        const r1 = yr[i1] * wr[t1] - yi[i1] * wi[t1], q1 = yr[i1] * wi[t1] + yi[i1] * wr[t1];
        const r2 = yr[i2] * wr[t2] - yi[i2] * wi[t2], q2 = yr[i2] * wi[t2] + yi[i2] * wr[t2];
        const sr = r1 + r2, si = q1 + q2, dr = r1 - r2, di = q1 - q2, mr = r0 - sr / 2, mi = q0 - si / 2;
        yr[i0] = r0 + sr; yi[i0] = q0 + si;
        yr[i1] = mr + h3 * di; yi[i1] = mi - h3 * dr; yr[i2] = mr - h3 * di; yi[i2] = mi + h3 * dr;
      }
    } else { // 5
      for (let k = 0; k < m; k++) {
        const i0 = yo + k, i1 = i0 + m, i2 = i1 + m, i3 = i2 + m, i4 = i3 + m, t1 = k * tw, t2 = 2 * t1, t3 = 3 * t1, t4 = 4 * t1;
        const r0 = yr[i0], q0 = yi[i0];
        const r1 = yr[i1] * wr[t1] - yi[i1] * wi[t1], q1 = yr[i1] * wi[t1] + yi[i1] * wr[t1];
        const r2 = yr[i2] * wr[t2] - yi[i2] * wi[t2], q2 = yr[i2] * wi[t2] + yi[i2] * wr[t2];
        const r3 = yr[i3] * wr[t3] - yi[i3] * wi[t3], q3 = yr[i3] * wi[t3] + yi[i3] * wr[t3];
        const r4 = yr[i4] * wr[t4] - yi[i4] * wi[t4], q4 = yr[i4] * wi[t4] + yi[i4] * wr[t4];
        const sa = r1 + r4, sb = q1 + q4, da = r1 - r4, db = q1 - q4, sc = r2 + r3, sd = q2 + q3, dc = r2 - r3, dd = q2 - q3;
        yr[i0] = r0 + sa + sc; yi[i0] = q0 + sb + sd;
        const A1r = r0 + c1 * sa + c2 * sc, A1i = q0 + c1 * sb + c2 * sd, A2r = r0 + c2 * sa + c1 * sc, A2i = q0 + c2 * sb + c1 * sd;
        const B1r = s1 * da + s2 * dc, B1i = s1 * db + s2 * dd, B2r = s2 * da - s1 * dc, B2i = s2 * db - s1 * dd;
        yr[i1] = A1r + B1i; yi[i1] = A1i - B1r; yr[i4] = A1r - B1i; yi[i4] = A1i + B1r;
        yr[i2] = A2r + B2i; yi[i2] = A2i - B2r; yr[i3] = A2r - B2i; yi[i3] = A2i + B2r;
      }
    }
  }
  // forward transform (e^{-i}); input x, output written back to (outR,outI)
  const fft = (xr, xi, outR, outI) => { rec(xr, xi, 0, 1, N, 0, 0); outR.set(yr); outI.set(yi); };
  return fft;
}
