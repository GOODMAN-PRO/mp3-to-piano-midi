import { BasicPitch } from '@spotify/basic-pitch';
import * as tf from '@tensorflow/tfjs';
import { extractNotes } from './extract.js';
import { toPianoNotes } from './piano.js';
import { notesToMidi } from './midi.js';

const form = document.querySelector('#form');
const fileInput = document.querySelector('#file');
const controls = document.querySelector('#controls');
const convert = document.querySelector('#convert');
const progress = document.querySelector('#progress');
const status = document.querySelector('#status');
const summary = document.querySelector('#summary');
const download = document.querySelector('#download');
let basicPitch;
let downloadUrl;

for (const id of ['sensitivity', 'threshold']) {
  const input = document.getElementById(id);
  input.addEventListener('input', () => {
    document.getElementById(`${id}-value`).value = input.value;
  });
}

fileInput.addEventListener('change', () => {
  convert.disabled = !fileInput.files.length;
  download.hidden = true;
  summary.textContent = '';
  progress.value = 0;
  status.textContent = fileInput.files.length ? 'Ready to convert.' : 'Choose an audio file to begin.';
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  const file = fileInput.files[0];
  if (!file || convert.disabled) return;

  const onsetThresh = Number(document.querySelector('#sensitivity').value);
  const frameThresh = Number(document.querySelector('#threshold').value);
  const minMs = Number(document.querySelector('#min-length').value);
  const maxPoly = Number(document.querySelector('#max-poly').value);
  const preset = document.querySelector('#preset').value;
  const splitHands = document.querySelector('#split').checked;
  controls.disabled = true;
  convert.disabled = true;
  download.hidden = true;
  summary.textContent = '';
  progress.value = 0;

  let failureMessage = 'Could not decode this audio. Try another file or a format supported by your browser.';
  try {
    status.textContent = 'Decoding audio…';
    const ctx = new AudioContext({ sampleRate: 22050 });
    let buffer;
    try {
      buffer = await ctx.decodeAudioData(await file.arrayBuffer());
    } finally {
      await ctx.close();
    }

    // Average channels before resampling so multichannel audio is also a true mono mix.
    let mono = new Float32Array(buffer.length);
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const samples = buffer.getChannelData(channel);
      for (let i = 0; i < samples.length; i++) {
        mono[i] += samples[i] / buffer.numberOfChannels;
      }
    }
    if (buffer.sampleRate !== 22050) {
      status.textContent = 'Resampling audio…';
      const offline = new OfflineAudioContext(1, Math.ceil(buffer.duration * 22050), 22050);
      const source = offline.createBufferSource();
      source.buffer = offline.createBuffer(1, mono.length, buffer.sampleRate);
      source.buffer.copyToChannel(mono, 0);
      source.connect(offline.destination);
      source.start();
      mono = (await offline.startRendering()).getChannelData(0);
    }

    failureMessage = 'Could not load the transcription model. Check your connection and reload the page to try again.';
    status.textContent = 'Loading transcription model…';
    basicPitch ??= new BasicPitch(import.meta.env.BASE_URL + 'model/model.json');
    await basicPitch.model.catch(error => { basicPitch = undefined; throw error; });

    failureMessage = 'Transcription failed. Try a shorter audio file or another browser.';
    const frames = [];
    const onsets = [];
    const transcribe = async () => {
      tf.engine().startScope(); // basic-pitch 1.0.1 leaks intermediate tensors; the scope frees them per conversion
      try {
        await basicPitch.evaluateModel(mono, (f, o) => {
          frames.push(...f);
          onsets.push(...o);
        }, pct => {
          progress.value = pct;
          status.textContent = `Transcribing audio (${tf.getBackend()})… ${Math.round(pct * 100)}%`;
        });
      } finally {
        tf.engine().endScope();
      }
    };
    try {
      await transcribe();
    } catch (error) {
      // Some GPUs/browsers fail to compile TF.js WebGL shaders; CPU is slow but works everywhere.
      if (tf.getBackend() === 'cpu') throw error;
      console.warn('WebGL inference failed, retrying on CPU', error);
      frames.length = onsets.length = 0;
      await tf.setBackend('cpu');
      await transcribe();
    }

    status.textContent = 'Creating piano MIDI…';
    failureMessage = 'Could not create the MIDI file. Try converting again.';
    const notes = extractNotes(frames, onsets, { onsetThresh, frameThresh, minMs });
    const piano = toPianoNotes(notes, { maxPoly, preset });

    const blob = new Blob([notesToMidi(piano, { splitHands })], { type: 'audio/midi' });
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    downloadUrl = URL.createObjectURL(blob);
    download.href = downloadUrl;
    download.download = `${file.name.replace(/\.[^.]+$/, '')}.mid`;
    download.hidden = false;
    const duration = piano.reduce((end, note) => Math.max(end, note.startTimeSeconds + note.durationSeconds), 0);
    summary.textContent = `${piano.length} notes · ${duration.toFixed(1)} seconds`;
    progress.value = 1;
    status.textContent = piano.length ? 'Done. Your MIDI is ready.'
      : preset === 'easy' ? 'No notes remain in Easy. Try Full or lower the thresholds.'
        : 'No notes remain. Try lowering the thresholds.';
  } catch (error) {
    console.error(error);
    status.textContent = failureMessage;
  } finally {
    controls.disabled = false;
    convert.disabled = !fileInput.files.length;
  }
});
