import { BasicPitch } from '@spotify/basic-pitch';
import * as tf from '@tensorflow/tfjs';
import { pianoDefaults, defaultMaxSounding, toPianoNotes } from './piano.js';
import { stemsDefaults, arrangeStems } from './stems.js';
import { downmixToStereo, decimate2, mono } from './separate.js';
import { probeWebGPU } from './separation-gpu.js';
import { notesToMidi } from './midi.js';

const $ = id => document.getElementById(id);
const form = $('form'), fileInput = $('file'), controls = $('controls');
const convert = $('convert'), cancel = $('cancel'), progress = $('progress');
const status = $('status'), summary = $('summary'), download = $('download');
let downloadUrl, active;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const abortError = () => new DOMException('Conversion cancelled.', 'AbortError');
const check = job => { if (job.controller.signal.aborted) throw abortError(); };

// Exposed and hidden stems settings originate in the same object as the CLI.
$('melody-hand').value = stemsDefaults.melodyHand;
$('melody-octave').value = String(stemsDefaults.melodyOctave);
$('backing').value = stemsDefaults.chordsOnly ? 'chords' : 'pulses';
function updateControls() {
  const stems = $('preset').value === 'stems';
  $('stems-controls').hidden = !stems;
  $('classic-controls').hidden = stems;
  $('max-poly').disabled = $('split').disabled = stems;
  $('model-notice').hidden = !stems;
}
$('preset').addEventListener('change', updateControls);
updateControls();
const gpuReady = probeWebGPU().catch(error => ({ supported: false, reason: error.message })).then(result => {
  if (!result.supported) {
    $('stems-option').disabled = true;
    $('stems-option').textContent = 'Vocal melody + backing: needs WebGPU (desktop Chrome/Edge)';
    if ($('preset').value === 'stems') $('preset').value = 'cover';
    $('gpu-notice').textContent = `${result.reason}. On Quest: convert on your PC and download the MIDI to the headset.`;
  } else {
    $('gpu-notice').textContent = 'WebGPU ready. On Quest: convert on your PC and download the MIDI to the headset.';
  }
  updateControls();
  return result;
});

for (const id of ['sensitivity', 'threshold']) {
  $(id).addEventListener('input', () => { $(`${id}-value`).value = $(id).value; });
}
fileInput.addEventListener('change', () => {
  convert.disabled = !fileInput.files.length;
  download.hidden = true;
  summary.textContent = '';
  $('conversion-notice').hidden = true;
  progress.value = 0;
  status.textContent = fileInput.files.length ? 'Ready to convert.' : 'Choose an audio file to begin.';
});
cancel.addEventListener('click', () => {
  if (!active) return;
  active.controller.abort();
  cancel.disabled = true;
  status.textContent = 'Cancelling…';
});

function report(job, value, message) {
  check(job);
  progress.value = Math.max(progress.value, value);
  status.textContent = message;
}
function notice(message) {
  $('conversion-notice').hidden = false;
  $('conversion-notice').textContent += ($('conversion-notice').textContent ? ' ' : '') + message;
}

// Termination also cancels synchronous FFT / extraction work. Only one Worker
// exists at a time; the separator releases its session before sending "done".
function runWorker(job, worker, message, transfers = [], onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const signal = job.controller.signal;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      worker.terminate();
      if (error) reject(error); else resolve(result);
    };
    const onAbort = () => {
      worker.postMessage({ type: 'cancel', id: message.id });
      finish(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    worker.onmessage = ({ data }) => {
      if (settled || signal.aborted) return;
      if (data.type === 'done') finish(null, data);
      else if (data.type === 'error') finish(new Error(data.reason));
      else if (data.type === 'cancel') finish(abortError());
      else if (data.type === 'warning') notice(data.message);
      else onProgress(data);
    };
    worker.onerror = event => { event.preventDefault?.(); finish(new Error(event.message || 'Worker failed')); };
    worker.onmessageerror = () => finish(new Error('Worker returned an unreadable message'));
    if (signal.aborted) onAbort();
    else worker.postMessage(message, transfers);
  });
}

async function decode(file, stems, job) {
  const ctx = new AudioContext({ sampleRate: stems ? 44100 : 22050 });
  let buffer;
  try { buffer = await ctx.decodeAudioData(await file.arrayBuffer()); }
  finally { await ctx.close(); }
  check(job);
  const rate = stems ? 44100 : 22050;
  if (buffer.sampleRate !== rate) {
    const offline = new OfflineAudioContext(buffer.numberOfChannels, Math.ceil(buffer.duration * rate), rate);
    const source = offline.createBufferSource();
    source.buffer = buffer;
    source.connect(offline.destination);
    source.start();
    buffer = await offline.startRendering();
    check(job);
  }
  if (stems) {
    const [left, right] = downmixToStereo(Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i)));
    // Keep a mono copy before transfer so failure never needs a second decode.
    return { left, right, mix: decimate2(mono(left, right)), duration: buffer.duration };
  }
  const mix = new Float32Array(buffer.length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const samples = buffer.getChannelData(channel);
    for (let i = 0; i < samples.length; i++) mix[i] += samples[i] / buffer.numberOfChannels;
  }
  return { mix, duration: buffer.duration };
}

async function transcribe(audio, job, stems) {
  const label = stems ? 'backing' : 'audio', frames = [], onsets = [];
  const base = stems ? 0.60 : 0.03, width = stems ? 0.32 : 0.89;
  report(job, base, 'Loading transcription model…');
  // Created only after session.release() AND separator Worker termination.
  const model = await tf.loadGraphModel(import.meta.env.BASE_URL + 'model/model.json', {
    requestInit: { signal: job.controller.signal },
    // TFJS's onProgress helper leaves unhandled promises on fetch abort.
    // A fetch wrapper reports bytes and propagates cancellation normally.
    fetchFunc: async (url, init) => {
      const response = await fetch(url, init);
      if (!response.ok || !response.body) return response;
      const reader = response.body.getReader(), chunks = [];
      const total = Number(response.headers.get('content-length'));
      let loaded = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          check(job);
          if (done) break;
          chunks.push(value); loaded += value.length;
          report(job, base, `Loading transcription model… ${total
            ? `${Math.min(100, Math.round(loaded / total * 100))}%` : `${Math.round(loaded / 1024)} KB`}`);
        }
      } finally { reader.releaseLock(); }
      return new Response(new Blob(chunks), { status: response.status, headers: response.headers });
    },
  });
  try {
    check(job);
    const basicPitch = new BasicPitch(Promise.resolve(model));
    // Yield and check before each batch; throwing stops evaluation and the
    // surrounding scope frees Basic Pitch's otherwise leaked intermediates.
    const evaluateFrame = basicPitch.evaluateSingleFrame?.bind(basicPitch);
    if (evaluateFrame) basicPitch.evaluateSingleFrame = async (...args) => {
      await tick();
      check(job);
      return evaluateFrame(...args);
    };
    const evaluate = async () => {
      tf.engine().startScope();
      try {
        await basicPitch.evaluateModel(audio, (f, o) => {
          check(job);
          frames.push(...f); onsets.push(...o);
        }, frac => report(job, base + width * frac,
          `Transcribing ${label} (${tf.getBackend()})… ${Math.round(frac * 100)}%`));
      } finally { tf.engine().endScope(); }
    };
    try { await evaluate(); }
    catch (error) {
      check(job);
      if (tf.getBackend() === 'cpu') throw error;
      console.warn('WebGL inference failed, retrying on CPU', error);
      frames.length = onsets.length = 0;
      await tf.setBackend('cpu');
      await evaluate();
    }
    return { frames, onsets };
  } finally { model.dispose(); }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const file = fileInput.files[0];
  if (!file || convert.disabled || active) return;
  const job = { controller: new AbortController(), started: performance.now() };
  active = job;
  controls.disabled = convert.disabled = true;
  cancel.hidden = false; cancel.disabled = false;
  download.hidden = true; summary.textContent = '';
  $('conversion-notice').hidden = true; $('conversion-notice').textContent = '';
  progress.value = 0;
  let failureMessage = 'Could not decode this audio. Try another file or a format supported by your browser.';
  try {
    const gpu = await gpuReady;
    check(job);
    let preset = $('preset').value, stems = preset === 'stems' && gpu.supported;
    const onsetThresh = Number($('sensitivity').value), frameThresh = Number($('threshold').value);
    const minMs = Number($('min-length').value), maxPoly = Number($('max-poly').value);
    const splitHands = $('split').checked, quantize = $('quantize').checked;
    const stemsOptions = { ...stemsDefaults, quantize,
      melodyHand: $('melody-hand').value, melodyOctave: Number($('melody-octave').value),
      chordsOnly: $('backing').value === 'chords',
    };
    report(job, 0, 'Decoding audio…');
    await tick();
    const decoded = await decode(file, stems, job);
    report(job, 0.03, 'Audio decoded.');
    let audio = decoded.mix, melody;
    if (stems) {
      try {
        const result = await runWorker(job,
          new Worker(new URL('./separate.worker.js', import.meta.url), { type: 'module' }),
          { type: 'start', id: 1, left: decoded.left, right: decoded.right, melodyOptions: stemsOptions },
          [decoded.left.buffer, decoded.right.buffer], data => {
            if (data.stage === 'model') report(job, data.cached ? 0.15 : 0.03 + 0.12 * data.frac,
              data.message || (data.cached ? 'Loading cached vocal-separation model…'
                : `Downloading vocal-separation model… ${Math.round(data.frac * 100)}%`));
            else if (data.stage === 'separating') report(job, 0.15 + 0.40 * data.frac,
              data.total ? `Separating vocals... ${Math.round(data.frac * 100)}% (chunk ${data.completed}/${data.total})`
                : 'Separating vocals... 0%');
            else if (data.stage === 'melody') report(job, 0.55 + 0.05 * data.frac,
              `Finding vocal melody… ${Math.round(data.frac * 100)}%`);
          });
        check(job);
        audio = result.inst22k; melody = result.melody;
      } catch (error) {
        check(job);
        const message = `Vocal separation failed (${error.message}); using Classic Cover instead.`;
        notice(message); status.textContent = message;
        stems = false; preset = 'cover';
        await tick();
      }
    }
    failureMessage = 'Transcription failed. Check your connection or try a shorter audio file.';
    const { frames, onsets } = await transcribe(audio, job, stems);
    failureMessage = 'Could not create the MIDI file. Try converting again.';
    report(job, 0.92, stems ? 'Extracting backing notes…' : 'Extracting notes…');
    // Extraction can take seconds on a long song. Keep it off the UI thread.
    const extractionOptions = { ...pianoDefaults, onsetThresh, frameThresh, minMs,
      ...(stems ? { melodiaTrick: false } : {}),
    };
    const extracted = await runWorker(job,
      new Worker(new URL('./extract.worker.js', import.meta.url), { type: 'module' }),
      { frames, onsets, options: extractionOptions });
    report(job, 0.95, 'Arranging piano MIDI…');
    await tick(); check(job);
    const piano = stems
      ? arrangeStems(melody, extracted.notes, { ...pianoDefaults, ...stemsOptions, durationSeconds: decoded.duration })
      : toPianoNotes(extracted.notes, { ...pianoDefaults, maxSounding: defaultMaxSounding(preset), maxPoly, preset, quantize });
    check(job);
    const blob = new Blob([notesToMidi(piano, { splitHands: stems || splitHands })], { type: 'audio/midi' });
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    downloadUrl = URL.createObjectURL(blob);
    download.href = downloadUrl;
    download.download = `${file.name.replace(/\.[^.]+$/, '')}.mid`;
    download.hidden = false;
    if (stems) {
      const left = Math.round(piano.melodyLeftShare * 100);
      summary.textContent = `${piano.length} notes · melody from ${piano.noVocals ? 'instrumental' : 'vocals'} ` +
        `(L ${left}% / R ${100 - left}%) · backing from instrumental · done in ${Math.round((performance.now() - job.started) / 1000)} s`;
      if (piano.noVocals) notice("No singing detected: using the instrumental's top line for the melody.");
    } else {
      const duration = piano.reduce((end, note) => Math.max(end, note.startTimeSeconds + note.durationSeconds), 0);
      summary.textContent = `${piano.length} notes · ${duration.toFixed(1)} seconds · ${piano.quantized
        ? `${piano.estimatedBpm.toFixed(1)} BPM grid` : 'original timing'}`;
    }
    progress.value = 1;
    status.textContent = piano.length ? 'Done. Your MIDI is ready.'
      : !stems && preset !== 'full' ? `No notes remain in ${preset === 'cover' ? 'Cover' : 'Easy'}. Try Full or lower the thresholds.`
        : 'No notes remain. Try lowering the thresholds.';
  } catch (error) {
    if (job.controller.signal.aborted) status.textContent = 'Cancelled. Choose settings and convert again.';
    else { console.error(error); status.textContent = failureMessage; }
  } finally {
    active = undefined;
    controls.disabled = false;
    convert.disabled = !fileInput.files.length;
    cancel.hidden = true;
    updateControls();
  }
});
