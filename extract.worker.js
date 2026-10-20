import { extractNotes } from './extract.js';

self.onmessage = ({ data }) => {
  try {
    self.postMessage({ type: 'done', notes: extractNotes(data.frames, data.onsets, data.options) });
  } catch (error) {
    self.postMessage({ type: 'error', reason: error.message });
  }
};
