import { separate, mono, decimate2 } from './separate.js';
import { melodyNotes } from './melody.js';

const MAX_SEPARATION_MS = 180_000;

// Kept independent of ORT and worker globals so the actual protocol can be
// exercised in CI with a synthetic inference function.
export function createSeparationWorkerHandler({
  post, initialize, separateImpl = separate, melodyImpl = melodyNotes,
  now = () => performance.now(), yieldTask = () => new Promise(resolve => setTimeout(resolve, 0)),
}) {
  let active;
  return async function handle(message) {
    if (message.type === 'cancel') {
      if (active && (message.id === undefined || message.id === active.id)) {
        active.cancelled = true;
        active.controller.abort(new DOMException('Conversion cancelled', 'AbortError'));
      }
      return;
    }
    if (message.type !== 'start') return;
    if (active) {
      post({ type: 'error', id: message.id, reason: 'A separation is already running' });
      return;
    }
    const job = { id: message.id, controller: new AbortController(), cancelled: false };
    active = job;
    const { signal } = job.controller;
    const check = () => signal.throwIfAborted();
    const progress = event => { check(); post({ type: 'progress', id: job.id, ...event }); };
    const warning = text => post({ type: 'warning', id: job.id, message: text });
    const started = now();
    let runtime, outcome, timer;
    try {
      if (!(message.left instanceof Float32Array) || !(message.right instanceof Float32Array)) {
        throw new Error('Separation needs two Float32Array audio channels');
      }
      runtime = await initialize({
        signal, onProgress: progress, onWarning: warning,
        onDeviceLost: reason => job.controller.abort(new Error(`WebGPU device lost: ${reason}`)),
      });
      check();
      let lastChunk = now();
      const chunkMs = [];
      timer = setTimeout(() => job.controller.abort(new Error('Separation exceeded the 3 minute limit')), MAX_SEPARATION_MS);
      progress({ stage: 'separating', frac: 0 });
      const separated = await separateImpl(message.left, message.right, async tensor => {
        check();
        const result = await runtime.infer(tensor);
        check();
        // Yield between chunks so cancel/device-lost messages can be handled.
        await yieldTask();
        check();
        return result;
      }, {
        onProgress(completed, total) {
          check();
          const at = now();
          chunkMs.push(at - lastChunk);
          lastChunk = at;
          if (completed === Math.min(2, total)) {
            const projected = chunkMs[0] + (chunkMs[1] ?? chunkMs[0]) * (total - 1);
            if (projected > MAX_SEPARATION_MS) {
              throw new Error(`Separation is too slow (projected ${Math.ceil(projected / 1000)} s; limit 180 s)`);
            }
          }
          progress({ stage: 'separating', frac: completed / total, completed, total });
        },
      });
      clearTimeout(timer);
      check();
      const decimateStart = now();
      progress({ stage: 'melody', frac: 0, message: 'Preparing vocal melody...' });
      const vocal22k = decimate2(mono(...separated.vocals));
      const inst22k = decimate2(mono(...separated.instrumental));
      const decimate = (now() - decimateStart) / 1000;
      await yieldTask();
      check();
      const melodyStart = now();
      const melody = melodyImpl(vocal22k, message.melodyOptions);
      check();
      const melodyTime = (now() - melodyStart) / 1000;
      progress({ stage: 'melody', frac: 1, message: 'Vocal melody ready.' });
      outcome = {
        type: 'done', id: job.id, melody, inst22k, chunks: separated.chunks,
        separationTimings: separated.timings, chunkMs: chunkMs.slice(0, 2),
        timings: {
          ...runtime.timings, separation: separated.timings.total,
          decimate, melody: melodyTime, total: (now() - started) / 1000,
        },
      };
    } catch (error) {
      outcome = job.cancelled ? { type: 'cancel', id: job.id }
        : { type: 'error', id: job.id, reason: error.message || String(error) };
    } finally {
      clearTimeout(timer);
      // A completion message is the promise that no separator session remains.
      try { await runtime?.release(); }
      catch (error) {
        if (outcome?.type === 'done') outcome = { type: 'error', id: job.id, reason: `GPU cleanup failed: ${error.message}` };
      }
      if (job.cancelled) outcome = { type: 'cancel', id: job.id };
      active = undefined;
    }
    post(outcome, outcome.type === 'done' ? [outcome.inst22k.buffer] : []);
  };
}
