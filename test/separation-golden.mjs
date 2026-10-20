// Local-only evidence. No copyrighted audio or model weights are distributed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { K, separate, stftChunk, mono, decimate2 } from '../separate.js';
import { extractMelody } from '../melody.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const research = process.env.SEP_RESEARCH_DIR || 'G:/Temp/sep-research';
const downloads = process.env.SEP_AUDIO_DIR || 'C:/Users/User/Downloads';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fixtures = [
  ['Dream lantern', 181, 'd69293c390a18cf8aafde6917536db68068e081715853c7b21c6e2eec4d6e606',
    'a9299ff9594f4968384bc76b28cd0a4712f4be29f5815fdec5efb22775f8b3a1'],
  ['Avicii - The Nights (Audio)', 260, '4e5b5c26b7d5023b89ff18005be4998df79cb0bf1d4fef04fb1055d5ae9faff3',
    '838795d768c23b45f5a839f512bbdf74b9406c5f8a0eff4be9159fea8cedf7d8'],
  ['LiSA - Crossing Field', 457, '109f3fc6bac721d31d79f755a9956d9adfe2c0db903c8bab4a74a77395116206',
    'f6b89fc23d21d2cd552e1d241f11786bc11723aca7e9215165047f2607ace42e'],
];

// RIFF chunks may include fact/LIST/JUNK and odd-byte padding. Probe stems use
// both PCM16 and IEEE float32; support WAVE_FORMAT_EXTENSIBLE for either too.
export function decodeWav(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Expected a RIFF WAVE file.');
  }
  let format, data;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const tag = buffer.toString('ascii', offset, offset + 4), size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > buffer.length) throw new Error('Truncated WAV chunk.');
    if (tag === 'fmt ') {
      if (size < 16) throw new Error('Invalid WAV format chunk.');
      let code = buffer.readUInt16LE(start);
      if (code === 0xfffe && size >= 40) code = buffer.readUInt16LE(start + 24);
      format = { code, channels: buffer.readUInt16LE(start + 2), sampleRate: buffer.readUInt32LE(start + 4),
        blockAlign: buffer.readUInt16LE(start + 12), bits: buffer.readUInt16LE(start + 14) };
    } else if (tag === 'data') data = buffer.subarray(start, start + size);
    offset = start + size + (size % 2);
  }
  if (!format || !data || !format.channels || ![16, 32].includes(format.bits)
    || !(format.code === 1 && format.bits === 16 || format.code === 3 && format.bits === 32)) {
    throw new Error('WAV must contain PCM16 or IEEE float32 samples.');
  }
  const bytes = format.bits / 8, stride = format.channels * bytes;
  if (format.blockAlign !== stride || data.length % stride) throw new Error('Invalid WAV sample alignment.');
  const channels = Array.from({ length: format.channels }, () => new Float32Array(data.length / stride));
  for (let i = 0; i < channels[0].length; i++) {
    for (let channel = 0; channel < channels.length; channel++) {
      const at = (i * channels.length + channel) * bytes;
      channels[channel][i] = format.code === 3 ? data.readFloatLE(at) : data.readInt16LE(at) / 32768;
    }
  }
  return { sampleRate: format.sampleRate, channels };
}

function sdr(reference, actual, length = reference.length) {
  let energy = 0, error = 0;
  assert.ok(actual.length >= length && reference.length >= length);
  for (let i = 0; i < length; i++) {
    energy += reference[i] ** 2;
    error += (reference[i] - actual[i]) ** 2;
  }
  return 10 * Math.log10(energy / Math.max(error, 1e-30));
}
function rawFloat(path) {
  const bytes = readFileSync(path);
  return new Float32Array(Uint8Array.from(bytes).buffer);
}

async function main() {
  const result = { excerptSeconds: 30, contextSeconds: 36, songs: [], torch: null };
  let ort, session;
  const model = [join(root, '.cache/models/Kim_Vocal_2.onnx'),
    join(research, 'downloads/kim_vocal_2/Kim_Vocal_2.onnx')].find(existsSync);
  if (model) {
    assert.equal(sha256(readFileSync(model)), 'ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b');
    try { ort = await import('onnxruntime-node'); } catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
      console.log('SKIP model parity: optional onnxruntime-node is absent.');
    }
  } else console.log('SKIP model parity: local Kim_Vocal_2 model is absent.');
  try {
    if (ort) {
      // CPU is the independent numerical reference; DML runs in the real CLI.
      session = await ort.InferenceSession.create(model, { executionProviders: ['cpu'], intraOpNumThreads: 8 });
    }
    for (const [song, count, vocalHash, instHash] of fixtures) {
      const vocalPath = join(research, 'stems', song, 'vocals.wav');
      const instPath = join(research, 'stems', song, 'instrumental.wav');
      if (!existsSync(vocalPath) || !existsSync(instPath)) {
        console.log(`SKIP ${song}: local probe stems are absent.`);
        continue;
      }
      const vocalBytes = readFileSync(vocalPath), instBytes = readFileSync(instPath);
      assert.equal(sha256(vocalBytes), vocalHash, `${song}: vocal fixture changed`);
      assert.equal(sha256(instBytes), instHash, `${song}: instrumental fixture changed`);
      const vocals = decodeWav(vocalBytes), instrumental = decodeWav(instBytes);
      assert.equal(vocals.sampleRate, K.SR);
      assert.equal(instrumental.sampleRate, K.SR);
      const started = performance.now();
      const notes = extractMelody(decimate2(mono(...vocals.channels)));
      assert.equal(notes.length, count, `${song}: frozen melody note count`);
      const measured = { song, melodyNotes: notes.length, melodySeconds: (performance.now() - started) / 1000 };
      console.log(`${song}: melody ${notes.length}/${count} notes in ${measured.melodySeconds.toFixed(2)} s`);
      const audioPath = join(downloads, `${song}.mp3`);
      if (session && existsSync(audioPath)) {
        // Keep six seconds after the 30-second scored excerpt: truncating input
        // at 30 changes the network context in the final scored chunks.
        const decoded = spawnSync('ffmpeg', ['-v', 'error', '-i', audioPath, '-t', '36',
          '-ac', '2', '-ar', '44100', '-f', 'f32le', '-'], { maxBuffer: 32 * 1024 * 1024, windowsHide: true });
        if (decoded.error) throw decoded.error;
        assert.equal(decoded.status, 0, decoded.stderr.toString());
        const samples = new Float32Array(Uint8Array.from(decoded.stdout).buffer);
        const L = new Float32Array(samples.length / 2), R = new Float32Array(L.length);
        for (let i = 0; i < L.length; i++) { L[i] = samples[2 * i]; R[i] = samples[2 * i + 1]; }
        const stems = await separate(L, R, async input => {
          const outputs = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, K.INPUT_SHAPE) });
          return outputs[session.outputNames[0]].data;
        });
        const length = 30 * K.SR;
        measured.vocalsSdrDb = vocals.channels.map((channel, i) => sdr(channel, stems.vocals[i], length));
        measured.instrumentalSdrDb = instrumental.channels.map((channel, i) => sdr(channel, stems.instrumental[i], length));
        assert.ok([...measured.vocalsSdrDb, ...measured.instrumentalSdrDb].every(value => value >= 40),
          `${song}: stems must match Python probe at >=40 dB`);
        measured.separationSeconds = stems.timings.total;
        console.log(`${song}: first 30 s SDR vocals ${measured.vocalsSdrDb.map(n => n.toFixed(2))}, `
          + `instrumental ${measured.instrumentalSdrDb.map(n => n.toFixed(2))} dB`);
      } else console.log(`SKIP ${song} model parity: optional runtime/model or input MP3 is absent.`);
      result.songs.push(measured);
    }
  } finally {
    await session?.release();
  }
  const dataDir = join(research, 'critic/data');
  if (['sig.f32', 'ref_x0.f32', 'ref_est_identity.f32'].every(name => existsSync(join(dataDir, name)))) {
    const mix = rawFloat(join(dataDir, 'sig.f32')), length = mix.length / 2;
    const L = new Float32Array(length), R = new Float32Array(length);
    for (let i = 0; i < length; i++) { L[i] = mix[2 * i]; R[i] = mix[2 * i + 1]; }
    const forwardSdrDb = sdr(rawFloat(join(dataDir, 'ref_x0.f32')), stftChunk(L, R));
    const reference = rawFloat(join(dataDir, 'ref_est_identity.f32'));
    const identity = await separate(L, R, input => input);
    const inverseSdrDb = identity.vocals.map((channel, side) => sdr(reference.subarray(side * length, (side + 1) * length),
      Float32Array.from(channel, value => value / K.COMP)));
    assert.ok(forwardSdrDb >= 120 && inverseSdrDb.every(value => value >= 120));
    result.torch = { forwardSdrDb, inverseSdrDb };
    console.log(`Torch parity: STFT ${forwardSdrDb.toFixed(2)} dB; identity ${inverseSdrDb.map(n => n.toFixed(2))} dB`);
  } else console.log('SKIP tensor parity: local torch fixtures are absent.');
  mkdirSync(join(root, '.cache'), { recursive: true });
  writeFileSync(join(root, '.cache/separation-golden.json'), JSON.stringify(result, null, 2));
  console.log(result.songs.length ? 'local separation and melody golden checks passed' : 'SKIP local separation goldens: no probe fixtures.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
