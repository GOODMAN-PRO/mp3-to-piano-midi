import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { K } from '../separate.js';
import { probeWebGPU, requestSeparationDevice, MIN_GPU_BUFFER_BYTES } from '../separation-gpu.js';
import { loadSeparationModel } from '../separation-model.js';
import { createSeparationWorkerHandler } from '../separation-worker-core.js';

const adapter = {
  info: { isFallbackAdapter: false },
  limits: { maxStorageBufferBindingSize: 2 ** 30, maxBufferSize: 2 ** 31 },
  requestDevice: async options => options,
};
const gpu = value => ({ requestAdapter: async () => value });
assert.equal((await probeWebGPU(null)).supported, false);
assert.equal((await probeWebGPU(gpu(null))).supported, false);
assert.match((await probeWebGPU(gpu({ ...adapter, info: { isFallbackAdapter: true } }))).reason, /software/);
for (const limit of Object.keys(adapter.limits)) {
  const small = { ...adapter, limits: { ...adapter.limits, [limit]: MIN_GPU_BUFFER_BYTES - 1 } };
  assert.match((await probeWebGPU(gpu(small))).reason, new RegExp(limit));
}
assert.equal((await probeWebGPU(gpu(adapter))).adapter, adapter);
assert.deepEqual((await requestSeparationDevice(adapter)).requiredLimits, adapter.limits);
assert.match((await probeWebGPU({ requestAdapter: async () => { throw new Error('GPU blocked'); } })).reason, /blocked/);

// Model downloads use only synthetic bytes, while exercising the real streaming,
// digest, cache reuse, corrupt-cache recovery and quota failure paths.
const bytes = new Uint8Array([7, 2, 9, 4, 8, 3, 1]);
const model = { url: 'https://example.invalid/model', bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'), cache: 'synthetic-model' };
let stored, requests = 0, writes = 0, deletes = 0;
const cache = {
  match: async () => stored?.clone(),
  put: async (url, response) => { assert.equal(url, model.url); stored = response; writes++; },
  delete: async () => { deletes++; stored = undefined; },
};
const progress = [], warnings = [];
const opts = {
  model, cryptoImpl: webcrypto, cacheStorage: { open: async name => { assert.equal(name, model.cache); return cache; } },
  onProgress: event => progress.push(event), onWarning: text => warnings.push(text),
  fetchImpl: async () => {
    requests++;
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(bytes.subarray(0, 3)); controller.enqueue(bytes.subarray(3)); controller.close(); },
    }));
  },
};
assert.deepEqual(new Uint8Array(await loadSeparationModel(opts)), bytes);
assert.equal(requests, 1);
assert.equal(writes, 1);
assert.deepEqual(progress.filter(item => item.loaded > 0).map(item => item.loaded), [3, 7]);
progress.length = 0;
assert.deepEqual(new Uint8Array(await loadSeparationModel(opts)), bytes);
assert.equal(requests, 1, 'A verified warm cache must avoid the model network request');
assert.ok(progress.every(item => item.cached));
stored = new Response(new Uint8Array(bytes.length));
assert.deepEqual(new Uint8Array(await loadSeparationModel(opts)), bytes);
assert.equal(deletes, 1);
assert.equal(requests, 2);
assert.match(warnings.at(-1), /SHA-256/);
stored = undefined;
const quota = { ...cache, put: async () => { throw new DOMException('full', 'QuotaExceededError'); } };
assert.deepEqual(new Uint8Array(await loadSeparationModel({ ...opts, cacheStorage: { open: async () => quota } })), bytes);
assert.match(warnings.at(-1), /cache is full; continuing without caching/);
for (const cacheStorage of [null, { open: async () => { throw new DOMException('blocked', 'SecurityError'); } }]) {
  const before = requests;
  assert.deepEqual(new Uint8Array(await loadSeparationModel({ ...opts, cacheStorage })), bytes);
  assert.equal(requests, before + 1, 'Unavailable Cache Storage must still allow a verified download');
  assert.match(warnings.at(-1), /caching is unavailable; continuing without caching/);
}
await assert.rejects(loadSeparationModel({ ...opts, cacheStorage: undefined,
  fetchImpl: async () => new Response(new Uint8Array(bytes.length)) }), /SHA-256/);
await assert.rejects(loadSeparationModel({ ...opts, cacheStorage: undefined,
  fetchImpl: async () => new Response(bytes.subarray(0, 3)) }), /incomplete/);
await assert.rejects(loadSeparationModel({ ...opts, cacheStorage: undefined,
  fetchImpl: async () => new Response('no', { status: 503 }) }), /HTTP 503/);
const aborted = new AbortController();
aborted.abort(new DOMException('stop', 'AbortError'));
await assert.rejects(loadSeparationModel({ ...opts, signal: aborted.signal }), /stop/);

const input = { type: 'start', id: 42,
  left: new Float32Array(1024).fill(0.1), right: new Float32Array(1024).fill(-0.05) };
const notes = [{ pitchMidi: 60, startTimeSeconds: 0, durationSeconds: 0.3, amplitude: 0.8 }];
const runProtocol = (infer, extra = {}) => {
  const messages = [], transfers = [], events = [];
  const handle = createSeparationWorkerHandler({
    post(message, transfer = []) { messages.push(message); transfers.push(transfer); events.push(message.type); },
    initialize: async ({ onProgress }) => {
      onProgress({ stage: 'model', frac: 1, cached: true });
      return { infer, release: async () => { events.push('release'); }, timings: { model: 0, session: 0 } };
    },
    melodyImpl: () => notes,
    ...extra,
  });
  return { handle, messages, transfers, events };
};
const successful = runProtocol(tensor => new Float32Array(tensor.length));
await successful.handle(input);
const done = successful.messages.at(-1);
assert.equal(done.type, 'done');
assert.equal(done.id, 42);
assert.equal(done.chunks, 1);
assert.deepEqual(done.melody, notes);
assert.equal(done.inst22k.length, 512);
assert.ok(done.inst22k.every(value => Math.abs(value - 0.025) < 1e-8));
assert.deepEqual(successful.transfers.at(-1), [done.inst22k.buffer]);
assert.deepEqual(successful.events.slice(-2), ['release', 'done'], 'GPU cleanup must precede completion');
assert.deepEqual(successful.messages.filter(message => message.type === 'progress').map(message => message.stage),
  ['model', 'separating', 'separating', 'melody', 'melody']);
const chunk = successful.messages.find(message => message.completed === 1);
assert.equal(chunk.total, 1);
assert.equal(chunk.frac, 1);

for (const value of [NaN, Infinity]) {
  const broken = runProtocol(tensor => { const out = new Float32Array(tensor.length); out[13] = value; return out; });
  await broken.handle(input);
  assert.equal(broken.messages.at(-1).type, 'error');
  assert.match(broken.messages.at(-1).reason, /non-finite.*chunk 1/);
  assert.deepEqual(broken.events.slice(-2), ['release', 'error']);
}
const failure = runProtocol(() => { throw new Error('Synthetic GPU failure'); });
await failure.handle(input);
assert.match(failure.messages.at(-1).reason, /Synthetic GPU failure/);
assert.deepEqual(failure.events.slice(-2), ['release', 'error']);

let unblock, started;
const reachedInfer = new Promise(resolve => { started = resolve; });
const cancelled = runProtocol(async tensor => {
  started();
  await new Promise(resolve => { unblock = resolve; });
  return new Float32Array(tensor.length);
});
const running = cancelled.handle(input);
await reachedInfer;
await cancelled.handle({ type: 'cancel', id: 42 });
unblock();
await running;
assert.deepEqual(cancelled.messages.at(-1), { type: 'cancel', id: 42 });
assert.deepEqual(cancelled.events.slice(-2), ['release', 'cancel']);
assert.equal(cancelled.messages.some(message => message.type === 'done'), false);

const lost = runProtocol(() => assert.fail('lost device must not infer'), {
  initialize: async ({ onDeviceLost }) => {
    onDeviceLost('adapter reset');
    return { infer: () => assert.fail(), release: async () => {} };
  },
});
await lost.handle(input);
assert.match(lost.messages.at(-1).reason, /WebGPU device lost: adapter reset/);

let clock = 0, measuredChunks = 0;
const slow = runProtocol(() => {}, {
  now: () => clock,
  separateImpl: async (left, right, infer, { onProgress }) => {
    for (let completed = 1; completed <= 4; completed++) {
      clock += 50_000;
      measuredChunks++;
      onProgress(completed, 4);
    }
    assert.fail('Projection must stop before chunk 3');
  },
});
await slow.handle(input);
assert.equal(measuredChunks, 2, 'Time chunks zero and one before projecting throughput');
assert.match(slow.messages.at(-1).reason, /projected 200 s/);
assert.deepEqual(slow.events.slice(-2), ['release', 'error']);

// Wrong protocol payloads should produce one useful error, without inference.
const invalid = runProtocol(() => assert.fail());
await invalid.handle({ type: 'start', id: 99, left: [0], right: [0] });
assert.match(invalid.messages.at(-1).reason, /Float32Array/);
assert.equal(K.INPUT_SHAPE.reduce((a, b) => a * b), 4 * 3072 * 256);
console.log('Worker protocol, finite-output guard, cancellation, GPU gate, time projection, and model cache tests passed');
