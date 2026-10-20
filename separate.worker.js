import * as ort from 'onnxruntime-web/webgpu';
import { K } from './separate.js';
import { probeWebGPU, requestSeparationDevice } from './separation-gpu.js';
import { loadSeparationModel } from './separation-model.js';
import { createSeparationWorkerHandler } from './separation-worker-core.js';

ort.env.wasm.numThreads = 1;

async function initialize({ signal, onProgress, onWarning, onDeviceLost }) {
  const probe = await probeWebGPU();
  if (!probe.supported) throw new Error(probe.reason);
  signal.throwIfAborted();
  const modelStart = performance.now();
  const bytes = await loadSeparationModel({
    signal, onProgress: event => onProgress({ stage: 'model', ...event }), onWarning,
  });
  const model = (performance.now() - modelStart) / 1000;
  onProgress({ stage: 'model', frac: 1, message: 'Loading vocal separation on the GPU...' });
  const device = await requestSeparationDevice(probe.adapter);
  let session, released = false, lostReason;
  const destroy = () => device.destroy();
  signal.addEventListener('abort', destroy, { once: true });
  const deviceLost = device.lost.then(info => {
    if (released || signal.aborted) return;
    lostReason = info.message || info.reason || 'unknown reason';
    onDeviceLost(lostReason);
  });
  try {
    signal.throwIfAborted();
    const sessionStart = performance.now();
    session = await ort.InferenceSession.create(bytes, {
      executionProviders: [{ name: 'webgpu', device }],
      graphOptimizationLevel: 'all',
    });
    signal.throwIfAborted();
    return {
      timings: { model, session: (performance.now() - sessionStart) / 1000 },
      async infer(input) {
        if (lostReason) throw new Error(`WebGPU device lost: ${lostReason}`);
        const tensor = new ort.Tensor('float32', input, K.INPUT_SHAPE);
        let output;
        try {
          output = await Promise.race([
            session.run({ [session.inputNames[0]]: tensor }),
            deviceLost.then(() => { throw signal.reason || new Error(`WebGPU device lost: ${lostReason}`); }),
          ]);
          // CPU output data is owned independently of the disposable ORT tensor.
          return new Float32Array(output[session.outputNames[0]].data);
        } finally {
          tensor.dispose();
          for (const value of Object.values(output || {})) value.dispose();
        }
      },
      async release() {
        released = true;
        signal.removeEventListener('abort', destroy);
        try { await session.release(); }
        finally { device.destroy(); }
      },
    };
  } catch (error) {
    released = true;
    signal.removeEventListener('abort', destroy);
    try { await session?.release(); }
    finally { device.destroy(); }
    throw error;
  }
}

const handle = createSeparationWorkerHandler({
  post: (message, transfer = []) => self.postMessage(message, transfer),
  initialize,
});
self.onmessage = ({ data }) => { void handle(data); };
