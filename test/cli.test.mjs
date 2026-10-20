import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
import { spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cacheDir = join(root, '.cache');
mkdirSync(cacheDir, { recursive: true });
const temporary = mkdtempSync(join(cacheDir, 'cli-synthetic-'));
assert.equal(dirname(resolve(temporary)), resolve(cacheDir));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const input = join(temporary, `${basename(temporary)}.wav`);
let cachePath, vocalPath, runtimeImports = 0;
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'onnxruntime-node') {
      runtimeImports++;
      throw Object.assign(new Error('Optional ONNX Runtime deliberately unavailable in synthetic test.'), {
        code: 'ERR_MODULE_NOT_FOUND',
      });
    }
    return nextResolve(specifier, context);
  },
});
const savedError = console.error;
try {
  const { convertFile } = await import('../cli.mjs');
  assert.equal(runtimeImports, 0, 'Importing the CLI must not load the optional runtime');
  console.error = () => {};

  const wav = Buffer.alloc(44 + 512 * 4);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(3, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(22050, 24); wav.writeUInt32LE(22050 * 4, 28);
  wav.writeUInt16LE(4, 32); wav.writeUInt16LE(32, 34);
  wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  for (let i = 0; i < 512; i++) wav.writeFloatLE(0.2 * Math.sin(2 * Math.PI * 220 * i / 22050), 44 + 4 * i);
  writeFileSync(input, wav);
  const source = statSync(input);
  cachePath = join(cacheDir, `${basename(input)}-${source.size}-stems.json`);
  vocalPath = cachePath.replace(/\.json$/, '-vocals.f32');
  const frames = Array.from({ length: 550 }, () => Array(88).fill(0));
  const onsets = frames.map(row => row.map(() => 0));
  for (let start = 4; start < 510; start += 43) {
    for (const pitch of [48, 52, 55]) {
      onsets[start][pitch - 21] = 0.95;
      for (let frame = start; frame < Math.min(start + 36, frames.length); frame++) frames[frame][pitch - 21] = 0.7;
    }
  }
  const melody = Array.from({ length: 20 }, (_, i) => ({
    pitchMidi: 52, startTimeSeconds: i * 0.3, durationSeconds: 0.27, amplitude: 0.8,
  }));
  const savedStems = join(temporary, 'saved-stems');
  mkdirSync(savedStems);
  const stemPaths = ['vocals.wav', 'instrumental.wav'].map(name => join(savedStems, name));
  writeFileSync(stemPaths[0], wav);
  const backingWav = Buffer.from(wav);
  backingWav.writeFloatLE(0.75, 44);
  writeFileSync(stemPaths[1], backingWav);
  const record = {
    input, mtimeMs: source.mtimeMs, modelStamp: statSync(join(root, 'public/model/model.json')).mtimeMs,
    pipelineHash: hash(Buffer.concat(['fft.js', 'separate.js', 'melody.js'].map(name => readFileSync(join(root, name))))),
    modelHash: 'ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b',
    frames, onsets, melody, duration: 6.4, provider: 'cpu', stemPaths,
    stemHashes: stemPaths.map(path => hash(readFileSync(path))),
    timings: { decode: 1, separation: 2, melody: 3, basicPitch: 4 },
  };
  writeFileSync(cachePath, JSON.stringify(record));
  writeFileSync(vocalPath, new Uint8Array(new Float32Array(22050).buffer));
  const options = { quantize: false, chordsOnly: true };

  const first = await convertFile(input, options);
  assert.equal(first.stats.mode, 'stems', 'Stems is the CLI default');
  assert.equal(first.stats.cacheHit, true);
  assert.equal(first.stats.timings.separation, 0);
  assert.equal(first.stats.timings.basicPitch, 0);
  assert.deepEqual(first.stats.inferenceTimings, record.timings);
  const vocalLine = first.piano.filter(note => note.role === 'melody');
  assert.equal(vocalLine.length, 20);
  assert.ok(vocalLine.every(note => note.pitch === 52 && note.hand === 'left'),
    'A cached low vocal melody must retain its pitch, role, and left hand');
  assert.ok(first.piano.some(note => note.role === 'accompaniment' && note.hand === 'right'));
  assert.equal(first.stats.melodyLeftShare, 1);
  assert.ok(first.midi.length > 0);

  const initialCache = readFileSync(cachePath);
  const adjusted = await convertFile(input, { ...options, onset: 0.999, frame: 0.99, lhGroove: 0.9 });
  assert.equal(adjusted.stats.cacheHit, true);
  assert.equal(adjusted.stats.timings.basicPitch, 0);
  assert.equal(adjusted.stats.timings.separation, 0);
  assert.ok(adjusted.piano.length < first.piano.length, 'Extraction parameters must affect the cached frames');
  assert.deepEqual(readFileSync(cachePath), initialCache, 'Parameter sweeps must not rewrite inference');

  const tuned = await convertFile(input, { ...options, theta: 0.85, splitDb: 99 });
  assert.equal(tuned.stats.cacheHit, true);
  assert.equal(tuned.stats.timings.separation, 0);
  assert.equal(tuned.stats.timings.basicPitch, 0);
  assert.ok(tuned.stats.timings.melody > 0, 'Melody tuning must reuse the cached vocal samples');
  assert.deepEqual(JSON.parse(readFileSync(cachePath)).melody, melody, 'Tuning must preserve the default cached melody');

  const kept = join(temporary, 'copied-stems');
  await convertFile(input, { ...options, keepStems: kept });
  assert.deepEqual(readFileSync(join(kept, 'vocals.wav')), wav);
  assert.deepEqual(readFileSync(join(kept, 'instrumental.wav')), backingWav);
  const movedRecord = JSON.parse(readFileSync(cachePath));
  assert.deepEqual(movedRecord.stemPaths, ['vocals.wav', 'instrumental.wav'].map(name => resolve(kept, name)));
  const repeated = await convertFile(input, { ...options, keepStems: kept });
  assert.equal(repeated.stats.timings.separation, 0, 'Repeated stem export must use the validated saved stems');
  assert.equal(runtimeImports, 0, 'All valid cached conversions must work without ONNX Runtime');

  // Protect either output filename before any model import or output write.
  for (const name of ['vocals.wav', 'instrumental.wav']) {
    const protectedInput = join(temporary, name);
    writeFileSync(protectedInput, wav);
    await assert.rejects(convertFile(protectedInput, { keepStems: temporary }), /must not overwrite the input/);
    assert.deepEqual(readFileSync(protectedInput), wav);
  }
  assert.equal(runtimeImports, 0);

  // A different song may have overwritten an export directory. Its bytes must
  // fail the saved SHA check and request regeneration, never be silently copied.
  writeFileSync(join(kept, 'vocals.wav'), backingWav);
  await assert.rejects(convertFile(input, { ...options, keepStems: kept }), /needs optional onnxruntime-node/);
  assert.ok(runtimeImports > 0);
  writeFileSync(join(kept, 'vocals.wav'), wav);
  rmSync(vocalPath);
  await assert.rejects(convertFile(input, { ...options, theta: 0.85 }), /needs optional onnxruntime-node/,
    'A missing tuning sidecar must request regeneration instead of failing with ENOENT');
  writeFileSync(cachePath, JSON.stringify({ ...movedRecord, pipelineHash: 'stale-code' }));
  await assert.rejects(convertFile(input, options), /needs optional onnxruntime-node/,
    'Changed separation code must invalidate the inference cache');

  for (const [args, expectedStatus, text] of [
    [['--help'], 0, /Default: separate vocals/],
    [[input, '--ep', 'invalid'], 1, /--ep must be dml or cpu/],
    [[input, '--theta', 'NaN'], 1, /needs a finite number/],
    [[input, '--keep-stems'], 1, /--keep-stems needs a value/],
  ]) {
    const child = spawnSync(process.execPath, [join(root, 'cli.mjs'), ...args], {
      encoding: 'utf8', windowsHide: true,
    });
    assert.ifError(child.error);
    assert.equal(child.status, expectedStatus);
    assert.match(child.stdout + child.stderr, text);
  }
} finally {
  console.error = savedError;
  hook.deregister();
  if (cachePath) rmSync(cachePath, { force: true });
  if (vocalPath) rmSync(vocalPath, { force: true });
  // The directory was created above with mkdtemp, and its resolved parent was checked.
  rmSync(temporary, { recursive: true, force: true });
}
console.log('CLI default, cache reuse, tuning, stem integrity, input protection, and argument tests passed');
