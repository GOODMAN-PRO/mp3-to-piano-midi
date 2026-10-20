import { cleanNotes, estimateKey, estimateTempo, finalizeNotes, trackMelody } from './piano.js';

// Browser, CLI and direct callers use the same stems controls.
export const stemsDefaults = Object.freeze({
  theta: 0.65, splitDb: 6, lhGroove: 0.6, rhLegato: 350, chordsOnly: false,
  melodyHand: 'auto', melodyOctave: 0,
});

const endOf = n => n.end ?? n.startTimeSeconds + n.durationSeconds;
const duration = n => endOf(n) - n.startTimeSeconds;
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[sorted.length >> 1] : 0;
};
const pc = pitch => (pitch % 12 + 12) % 12;
const fold = pitch => {
  if (pitch < 36) pitch = 36 + ((pitch - 36) % 12 + 12) % 12;
  if (pitch > 96) pitch = 85 + ((pitch - 85) % 12 + 12) % 12;
  return pitch;
};
const internal = notes => notes.filter(n => n && Number.isFinite(n.startTimeSeconds) &&
  Number.isFinite(endOf(n)) && endOf(n) > n.startTimeSeconds &&
  Number.isFinite(n.pitch ?? n.pitchMidi)).map(n => ({
  ...n, pitch: Math.round(n.pitch ?? n.pitchMidi), end: endOf(n),
  amplitude: Number.isFinite(n.amplitude) ? Math.max(0, n.amplitude) : 0.7,
})).sort((a, b) => a.startTimeSeconds - b.startTimeSeconds || a.pitch - b.pitch);

export function weightedMedianPitch(notes) {
  const sorted = [...notes].sort((a, b) => (a.pitch ?? a.pitchMidi) - (b.pitch ?? b.pitchMidi));
  const total = sorted.reduce((sum, n) => sum + Math.max(0, duration(n)), 0);
  let weight = 0;
  for (const n of sorted) {
    weight += Math.max(0, duration(n));
    if (weight >= total / 2) return n.pitch ?? n.pitchMidi;
  }
  return null;
}

export function groupBy30(notes) {
  const sorted = [...notes].sort((a, b) => a.startTimeSeconds - b.startTimeSeconds), groups = [];
  for (let i = 0; i < sorted.length;) {
    let j = i + 1;
    while (j < sorted.length && sorted[j].startTimeSeconds - sorted[i].startTimeSeconds <= 0.03 + 1e-9) j++;
    groups.push(sorted.slice(i, j));
    i = j;
  }
  return groups;
}

// A short phrase shares its nearest >=4 s neighbour's decision. If every phrase
// is short, adjacent phrases decide together; a trailing singleton joins the
// preceding pair. An explicit octave shift precedes folding and hand assignment.
export function assignMelodyHands(notes, tempo = {}, options = {}) {
  const melodyHand = options.melodyHand ?? stemsDefaults.melodyHand;
  const melodyOctave = options.melodyOctave ?? stemsDefaults.melodyOctave;
  if (!['auto', 'left', 'right'].includes(melodyHand)) throw new Error('melodyHand must be auto, left or right.');
  if (![-1, 0, 1].includes(melodyOctave)) throw new Error('melodyOctave must be -1, 0 or 1.');
  const line = internal(notes).map(n => ({ ...n, pitch: fold(n.pitch + 12 * melodyOctave), role: 'melody' }));
  const rest = tempo.eligible ? 2 * 60 / tempo.estimatedBpm : 1;
  const phrases = [];
  for (const n of line) {
    let phrase = phrases.at(-1);
    if (!phrase || n.startTimeSeconds - phrase.end >= rest - 1e-9) {
      phrase = { start: n.startTimeSeconds, end: n.end, notes: [] };
      phrases.push(phrase);
    }
    phrase.notes.push(n);
    phrase.end = Math.max(phrase.end, n.end);
  }
  const anchors = phrases.map((p, i) => p.end - p.start >= 4 - 1e-9 ? i : -1).filter(i => i >= 0);
  const groups = new Map();
  phrases.forEach((p, i) => {
    let owner = anchors[0] ?? Math.min(2 * Math.floor(i / 2), Math.max(0, 2 * Math.floor((phrases.length - 2) / 2)));
    let distance = Infinity;
    for (const j of anchors) {
      const d = j < i ? p.start - phrases[j].end : j > i ? phrases[j].start - p.end : 0;
      if (d < distance) { owner = j; distance = d; }
    }
    if (!groups.has(owner)) groups.set(owner, []);
    groups.get(owner).push(i);
  });
  let previous;
  for (const indices of [...groups.values()].sort((a, b) => a[0] - b[0])) {
    const m = weightedMedianPitch(indices.flatMap(i => phrases[i].notes));
    const hand = melodyHand !== 'auto' ? melodyHand :
      m >= 60 ? 'right' : m <= 57 ? 'left' : previous ?? (m >= 59 ? 'right' : 'left');
    for (const i of indices) {
      const p = phrases[i];
      p.hand = hand;
      p.medianPitch = weightedMedianPitch(p.notes);
      p.decisionMedianPitch = m;
      p.maxPitch = Math.max(...p.notes.map(n => n.pitch));
      for (const n of p.notes) { n.hand = hand; n.phraseMaxPitch = p.maxPitch; }
    }
    previous = hand;
  }
  return { notes: line, phrases };
}

const templates = [
  ['maj', [0, 4, 7], [1, 0.8, 0.7]],
  ['min', [0, 3, 7], [1, 0.8, 0.7]],
  ['pow', [0, 7], [1, 0.8]],
];
const names = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const chordTones = state => templates[state % 3][1].map(p => (Math.floor(state / 3) + p) % 12);

// Beat chroma, 36 chord templates + silence, and a constant-cost Viterbi.
// Exposed separately so the Melodia ablation compares the actual arranger.
export function inferChords(instrumental, tempo = {}, key, { melody = [] } = {}) {
  const inst = internal(instrumental), vocal = internal(melody);
  const grid = Boolean(tempo.eligible), beat = grid ? 60 / tempo.estimatedBpm : 0.5;
  if (!inst.length) return { segments: [], grid, beat, phase: 0, slots: new Map(), grooveRef: 0 };
  const first = inst[0].startTimeSeconds, last = Math.max(...inst.map(n => n.end));
  const weight = n => n.amplitude * (n.pitch <= 55 ? 2 : 1);
  let phase = grid ? tempo.gridPhaseSeconds : first;
  if (grid) {
    let best = -1;
    for (let j = 0; j < 4; j++) {
      const candidate = tempo.gridPhaseSeconds + j * beat / 4;
      let score = 0;
      for (const n of inst) {
        const d = ((n.startTimeSeconds - candidate) / beat % 1 + 1.5) % 1 - 0.5;
        if (Math.abs(d) * beat < 0.04) score += weight(n);
      }
      if (score > best) { best = score; phase = candidate; }
    }
  }
  const firstFrame = Math.floor((first - phase) / beat);
  const count = Math.max(1, Math.ceil((last - phase) / beat) - firstFrame);
  const at = f => phase + (firstFrame + f) * beat;
  const chroma = Array.from({ length: count }, () => new Float64Array(12));
  const low = Array.from({ length: count }, () => new Float64Array(12));
  for (const n of inst) {
    if (n.pitch < 28 || n.pitch > 88) continue;
    for (let f = Math.max(0, Math.floor((n.startTimeSeconds - phase) / beat) - firstFrame);
      f < count && at(f) < n.end; f++) {
      const overlap = Math.min(n.end, at(f + 1)) - Math.max(n.startTimeSeconds, at(f));
      if (overlap <= 0) continue;
      const w = n.amplitude * overlap, isLow = n.pitch <= 55;
      chroma[f][pc(n.pitch)] += w * (isLow ? 1.5 : 1);
      if (isLow) low[f][pc(n.pitch)] += w;
    }
  }
  const energy = chroma.map(c => c.reduce((sum, x) => sum + x, 0));
  const medianEnergy = median(energy.filter(x => x > 0));
  const emission = chroma.map((c, f) => {
    const result = new Float64Array(37), norm = Math.hypot(...c);
    if (energy[f] < 0.1 * medianEnergy || !norm) { result[36] = 1; return result; }
    const lowSum = low[f].reduce((sum, x) => sum + x, 0);
    // Each beat is strong relative to its half-beat pulses; no meter is assumed.
    const sounding = vocal.filter(n => n.startTimeSeconds <= at(f) + 0.04 && n.end > at(f));
    for (let s = 0; s < 36; s++) {
      const root = Math.floor(s / 3), [, intervals, weights] = templates[s % 3];
      const tones = chordTones(s);
      const dot = intervals.reduce((sum, p, k) => sum + c[(root + p) % 12] * weights[k], 0);
      let score = dot / (norm * Math.hypot(...weights)) + (lowSum ? 0.15 * low[f][root] / lowSum : 0);
      if (key && tones.every(p => key.scale.includes(p))) score *= 1.08;
      if (s % 3 === 2) score *= 0.92;
      if (sounding.length) score += 0.18 * sounding.filter(n => tones.includes(pc(n.pitch))).length / sounding.length;
      result[s] = score;
    }
    return result;
  });
  let scores = Float64Array.from(emission[0]);
  const back = [];
  for (let f = 1; f < count; f++) {
    let best = 0;
    for (let s = 1; s < 37; s++) if (scores[s] > scores[best]) best = s;
    const next = new Float64Array(37), from = new Int8Array(37);
    for (let s = 0; s < 37; s++) {
      from[s] = scores[s] >= scores[best] - 0.25 ? s : best;
      next[s] = scores[from[s]] - (from[s] === s ? 0 : 0.25) + emission[f][s];
    }
    scores = next;
    back.push(from);
  }
  let state = 0;
  for (let s = 1; s < 37; s++) if (scores[s] > scores[state]) state = s;
  const states = [];
  for (let f = count - 1; f >= 0; f--) {
    states[f] = state;
    if (f) state = back[f - 1][state];
  }
  let segments = [];
  for (let f = 0; f < count; f++) {
    if (segments.at(-1)?.state === states[f]) segments.at(-1).f1 = f + 1;
    else segments.push({ state: states[f], f0: f, f1: f + 1 });
  }
  const dwell = grid ? 2 : 3;
  for (;;) {
    const k = segments.findIndex(s => s.f1 - s.f0 < dwell && segments.length > 1);
    if (k < 0) break;
    const gain = neighbour => {
      let sum = 0;
      if (!neighbour) return -Infinity;
      for (let f = segments[k].f0; f < segments[k].f1; f++) sum += emission[f][neighbour.state];
      return sum;
    };
    const target = gain(segments[k - 1]) >= gain(segments[k + 1]) ? k - 1 : k + 1;
    segments[target].f0 = Math.min(segments[target].f0, segments[k].f0);
    segments[target].f1 = Math.max(segments[target].f1, segments[k].f1);
    segments.splice(k, 1);
    segments = segments.reduce((out, s) => {
      if (out.at(-1)?.state === s.state) out.at(-1).f1 = s.f1;
      else out.push(s);
      return out;
    }, []);
  }
  const starts = segments.map(s => Math.max(0, at(s.f0)));
  if (!grid) for (let i = 1; i < starts.length; i++) {
    const near = inst.filter(n => Math.abs(n.startTimeSeconds - starts[i]) <= 0.25)
      .sort((a, b) => weight(b) - weight(a))[0];
    if (near && near.startTimeSeconds > starts[i - 1] + 0.5) starts[i] = near.startTimeSeconds;
  }
  segments = segments.map((s, i) => {
    const bassWeights = new Float64Array(12);
    for (let f = s.f0; f < s.f1; f++) for (let p = 0; p < 12; p++) bassWeights[p] += low[f][p];
    const root = s.state === 36 ? null : Math.floor(s.state / 3);
    return { ...s, start: starts[i], end: starts[i + 1] ?? Math.min(at(s.f1), last + 0.5),
      root, label: root === null ? 'N' : names[root] + ['', 'm', '5'][s.state % 3],
      tones: root === null ? [] : chordTones(s.state), bassWeights };
  });
  const step = grid ? beat / 2 >= 0.34 ? beat / 2 : beat : 0.5;
  const slots = new Map();
  for (const n of inst) {
    const k = Math.round((n.startTimeSeconds - phase) / step);
    slots.set(k, (slots.get(k) ?? 0) + n.amplitude);
  }
  return { segments, grid, beat, phase, step, slots, grooveRef: median([...slots.values()]) };
}

function leftVoicing(segment, previous) {
  const { tones, root, bassWeights } = segment;
  let bassPc = tones.reduce((best, p) => bassWeights[p] > bassWeights[best] ? p : best, root);
  if (!bassWeights[bassPc]) bassPc = root;
  const voices = tones.filter(p => p !== bassPc);
  while (voices.length < 2) voices.push(bassPc);
  let best;
  for (let bass = 40; bass <= 52; bass++) {
    if (pc(bass) !== bassPc) continue;
    for (let a = bass + 3; a <= Math.min(59, bass + 14); a++) for (let b = a + 3; b <= Math.min(59, bass + 14); b++) {
      if (!(pc(a) === voices[0] && pc(b) === voices[1] || pc(a) === voices[1] && pc(b) === voices[0])) continue;
      const cost = Math.abs(bass - (previous?.[0] ?? 45)) + 0.15 * Math.abs(bass - 45) +
        (previous ? 0.7 * (Math.abs(a - previous[1]) + Math.abs(b - previous[2])) : 0) +
        0.05 * Math.abs((a + b) / 2 - 54);
      if (!best || cost < best.cost) best = { pitches: [bass, a, b], cost };
    }
  }
  return best?.pitches ?? [];
}

function rightVoicing(segment, low, previous) {
  const choices = [];
  for (let p = low; p <= 81; p++) if (segment.tones.includes(pc(p))) choices.push(p);
  let best;
  for (const a of choices) for (const b of choices) {
    if (b - a < 3 || b - a > 14) continue;
    const thirds = choices.filter(c => c - b >= 3 && c - a <= 14 &&
      new Set([pc(a), pc(b), pc(c)]).size >= Math.min(3, segment.tones.length));
    for (const c of thirds.length ? thirds : [null]) {
      const pitches = c === null ? [a, b] : [a, b, c];
      const cost = Math.abs(a - (previous?.[0] ?? 64)) + 0.15 * Math.abs(a - 64) +
        (previous ? 0.7 * pitches.slice(1).reduce((sum, p, i) => sum + Math.abs(p - (previous[i + 1] ?? previous.at(-1))), 0) : 0) +
        0.05 * Math.abs((a + pitches.at(-1)) / 2 - 72) + (c === null ? 3 : 0);
      if (!best || cost < best.cost) best = { pitches, cost };
    }
  }
  return best?.pitches ?? [];
}

function attacksFor(segment, inst, harmony, groove) {
  const { start, end } = segment, { grid, beat, phase, step, slots, grooveRef } = harmony;
  const attacks = [{ t: start, block: true }];
  if (grid) {
    for (let t = start + step; t < end - 0.5 * step; t += step) {
      const block = Math.abs((t - start) / (4 * beat) - Math.round((t - start) / (4 * beat))) < 1e-6;
      if (block || (slots.get(Math.round((t - phase) / step)) ?? 0) >= groove * grooveRef) attacks.push({ t, block });
    }
  } else {
    for (let t = start + 2; t < end - 0.5; t += 2) attacks.push({ t, block: true });
    if (groove !== Infinity) for (const group of groupBy30(inst.filter(n => n.startTimeSeconds > start + 0.5 &&
      n.startTimeSeconds < end - 0.3))) {
      const t = group[0].startTimeSeconds;
      if (group.reduce((sum, n) => sum + n.amplitude, 0) >= groove * grooveRef &&
        attacks.every(a => Math.abs(a.t - t) >= 0.5)) attacks.push({ t, block: false });
    }
    attacks.sort((a, b) => a.t - b.t);
  }
  return attacks;
}

function accompaniment(inst, line, phrases, harmony, options) {
  const out = [], previous = { left: null, right: null }, lastByPitch = new Map();
  const amps = inst.map(n => n.amplitude).sort((a, b) => a - b), p95 = amps[Math.floor(0.95 * (amps.length - 1))] || 1;
  const phraseAt = time => phrases.findLast(p => p.start <= time + 1e-9) ?? phrases[0] ??
    { hand: 'right', maxPitch: 60 };
  for (const chord of harmony.segments) {
    if (!chord.tones.length) continue;
    const bounds = [chord.start, ...phrases.filter(p => p.start > chord.start && p.start < chord.end).map(p => p.start), chord.end];
    for (let part = 0; part < bounds.length - 1; part++) {
      const segment = { ...chord, start: bounds[part], end: bounds[part + 1] };
      const phrase = phraseAt(segment.start), hand = phrase.hand === 'right' ? 'left' : 'right';
      const low = hand === 'right' ? Math.max(60, phrase.maxPitch + 3) : 40;
      const pitches = hand === 'left' ? leftVoicing(segment, previous.left) : rightVoicing(segment, low, previous.right);
      if (!pitches.length) continue;
      previous[hand] = pitches;
      let weighted = 0, time = 0;
      for (const n of inst) {
        const overlap = Math.min(n.end, segment.end) - Math.max(n.startTimeSeconds, segment.start);
        if (overlap > 0) { weighted += n.amplitude * overlap; time += overlap; }
      }
      const amplitude = Math.min(1, (time ? weighted / time : 0.5) / p95);
      let root;
      // Auto retains the optional shared-hand bass root; explicit hand controls
      // reserve that entire hand for the melody.
      if (hand === 'right' && part === 0 && options.melodyHand === 'auto') {
        const sounding = line.filter(n => n.startTimeSeconds <= segment.start + 1e-9 && n.end > segment.start);
        const choices = Array.from({ length: 13 }, (_, k) => k + 40).filter(p => pc(p) === chord.root &&
          sounding.every(n => n.pitch - p >= 5 && n.pitch - p <= 12));
        if (choices.length) {
          const pitch = choices.sort((a, b) => Math.abs(a - 45) - Math.abs(b - 45))[0];
          const conflict = line.find(n => n.startTimeSeconds > segment.start && n.startTimeSeconds < segment.end &&
            (n.pitch - pitch < 5 || n.pitch - pitch > 12));
          root = { pitch, startTimeSeconds: segment.start, end: conflict?.startTimeSeconds ?? segment.end,
            amplitude, velocity: 0.3 + 0.3 * amplitude, hand: 'left', role: 'bass',
            chordTones: [chord.root], registerLow: 40, registerHigh: 52, placement: 'root', onset: 1 };
          if (duration(root) >= 0.12) out.push(root);
          else root = null;
        }
      }
      let pulse = 0;
      const events = attacksFor(segment, inst, harmony, options.chordsOnly ? Infinity : options.lhGroove).map(attack => ({
        ...attack,
        pitches: attack.block ? root && attack.t === segment.start ? pitches.slice(-2) : pitches :
          [pitches[hand === 'left' ? 1 + pulse++ % 2 : pulse++ % pitches.length]],
      }));
      events.forEach((event, j) => {
        for (const pitch of event.pitches) {
          const next = events.slice(j + 1).find(e => e.pitches.includes(pitch));
          const end = Math.min(next ? next.t - (harmony.grid ? harmony.beat / 4 : 0.06) : Infinity, segment.end);
          if (end - event.t < 0.12) continue;
          const role = hand === 'left' && pitch === pitches[0] ? 'bass' : 'accompaniment';
          const a = amplitude * (event.block ? role === 'bass' ? 1 : 0.8 : 0.7);
          const note = { pitch, startTimeSeconds: event.t, end, amplitude: a, velocity: 0.3 + 0.3 * a,
            hand, role, chord: event.pitches.length > 1, onset: 1, chordTones: chord.tones,
            registerLow: low, registerHigh: hand === 'right' ? 81 : role === 'bass' ? 52 : 59,
            placement: hand === 'left' ? 'below' : 'above' };
          const previousNote = lastByPitch.get(`${hand}:${pitch}`);
          if (j === 0 && previousNote && Math.abs(previousNote.end - event.t) < 1e-9 &&
            previousNote.placement === note.placement && previousNote.registerLow === low) {
            previousNote.end = end;
            previousNote.chordTones = previousNote.chordTones.filter(p => chord.tones.includes(p));
          } else {
            out.push(note);
            lastByPitch.set(`${hand}:${pitch}`, note);
          }
        }
      });
    }
  }
  return out;
}

// Revoice a whole held chord tone against every melody note it overlaps. This
// avoids introducing little accompaniment fragments around non-chord tones.
export function filterClashes(notes) {
  const copied = internal(notes), melody = copied.filter(n => n.role === 'melody');
  return copied.filter(n => {
    if (n.role === 'melody') return true;
    const sounding = melody.filter(m => m.startTimeSeconds < n.end - 1e-9 && m.end > n.startTimeSeconds + 1e-9);
    const safe = pitch => sounding.every(m => {
      const interval = Math.abs(pitch - m.pitch) % 12;
      if (interval === 1 || interval === 11 || pitch === m.pitch) return false;
      if (n.placement === 'below' && pitch > m.pitch - 2) return false;
      if (n.placement === 'above' && pitch < Math.max(60, (m.phraseMaxPitch ?? m.pitch) + 3)) return false;
      if ((n.placement === 'below' || n.placement === 'above') && n.hand === m.hand) return false;
      if (n.placement === 'root' && (m.pitch - pitch < 5 || m.pitch - pitch > 12)) return false;
      return n.hand !== m.hand || Math.abs(pitch - m.pitch) <= 14;
    });
    if (safe(n.pitch)) return true;
    const choices = [];
    for (let p = n.registerLow ?? 36; p <= (n.registerHigh ?? 96); p++) {
      if ((n.chordTones ?? [pc(n.pitch)]).includes(pc(p)) && safe(p)) choices.push(p);
    }
    choices.sort((a, b) => Math.abs(a - n.pitch) - Math.abs(b - n.pitch) || a - b);
    if (!choices.length) return false;
    n.pitch = choices[0];
    return true;
  });
}

export function enforcePlayability(notes, bpm = 120) {
  let out = internal(notes);
  const tick = 60 / (bpm * 480), priority = n => n.role === 'melody' ? 2 : n.role === 'bass' ? 0 : 1;
  // Quantization can lengthen a vocal past its successor; retain a small release.
  const line = out.filter(n => n.role === 'melody');
  for (let i = 0; i < line.length - 1; i++) {
    if (line[i].end > line[i + 1].startTimeSeconds - tick) line[i].end = line[i + 1].startTimeSeconds - tick;
  }
  out = out.filter(n => duration(n) > tick / 2);
  // No shared piano key can sound in both tracks, even at a rounded MIDI tick.
  const byPitch = new Map();
  for (const n of out.filter(n => duration(n) > 0)) {
    if (!byPitch.has(n.pitch)) byPitch.set(n.pitch, []);
    byPitch.get(n.pitch).push(n);
  }
  for (const sequence of byPitch.values()) {
    let a = sequence[0];
    for (const b of sequence.slice(1)) {
      if (Math.round(a.startTimeSeconds / tick) === Math.round(b.startTimeSeconds / tick)) {
        if (priority(a) >= priority(b)) { b.end = b.startTimeSeconds; continue; }
        a.end = a.startTimeSeconds;
      } else if (a.end > b.startTimeSeconds - (a.hand !== b.hand ? tick : 0)) {
        a.end = b.startTimeSeconds - (a.hand !== b.hand ? tick : 0);
      }
      a = b;
    }
  }
  out = out.filter(n => duration(n) >= (n.role === 'melody' ? tick : 0.12) - 1e-9);
  // The classic cap protects fresh attacks; stems also enforce a strict cap.
  const active = [];
  for (const n of out) {
    for (let i = active.length - 1; i >= 0; i--) if (active[i].end <= n.startTimeSeconds + 1e-9) active.splice(i, 1);
    active.push(n);
    const left = active.filter(n => n.hand === 'left');
    const leftMelodyExcess = left.length > 2 && left.some(n => n.role === 'melody');
    if (active.length > 4 || leftMelodyExcess) {
      const drop = [...(leftMelodyExcess ? left : active)]
        .sort((a, b) => priority(a) - priority(b) || a.amplitude - b.amplitude)[0];
      drop.end = n.startTimeSeconds;
      active.splice(active.indexOf(drop), 1);
    }
  }
  out = out.filter(n => duration(n) >= (n.role === 'melody' ? tick : 0.12) - 1e-9);
  // Removing a group anchor can regroup the following attacks. Repeat until
  // the final surviving notes, rather than their old groups, are playable.
  for (;;) {
    const removed = new Set();
    const groups = [out, out.filter(n => n.hand === 'left'), out.filter(n => n.hand === 'right')]
      .flatMap(notes => [...groupBy30(notes),
        ...groupBy30(notes.map(n => ({ startTimeSeconds: Math.round(n.startTimeSeconds / tick) * tick, note: n })))
          .map(group => group.map(n => n.note))]);
    for (const group of groups) for (const hand of ['left', 'right']) {
      const kept = [];
      for (const n of group.filter(n => n.hand === hand)
        .sort((a, b) => priority(b) - priority(a) || b.amplitude - a.amplitude)) {
        const pitches = [...kept.map(p => p.pitch), n.pitch];
        if (kept.length < 5 && Math.max(...pitches) - Math.min(...pitches) <= 14) kept.push(n);
        else removed.add(n);
      }
    }
    if (!removed.size) break;
    out = out.filter(n => !removed.has(n));
  }
  return out.map(n => ({ ...n, pitchMidi: n.pitch, durationSeconds: duration(n) }));
}

export function arrangeStems(melodyNotes, instrumentalNotes, options = {}) {
  options = { ...stemsDefaults, ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) };
  const rawInst = internal(instrumentalNotes).map(n => ({ ...n, pitchMidi: n.pitch, durationSeconds: duration(n) }));
  const inst = cleanNotes(rawInst, options);
  // Tempo follows attacks. Melodia's onset-less sustain continuations must not
  // move the beat grid, but still contribute to the full harmonic chroma.
  const attacks = rawInst.some(n => n.onset === 0) ? cleanNotes(rawInst.filter(n => n.onset !== 0), options) : inst;
  const vocal = internal(melodyNotes);
  let tempo = options.tempo ?? estimateTempo(attacks);
  if (!tempo.eligible && !options.tempo) tempo = estimateTempo([...attacks, ...vocal]);
  const last = Math.max(0, ...inst.map(n => n.end), ...vocal.map(n => n.end), options.durationSeconds ?? 0);
  const vocalTime = vocal.reduce((sum, n) => sum + duration(n), 0);
  const noVocals = vocal.length < 15 || vocalTime < last * 0.08;
  let line = noVocals ? [] : vocal.map(n => ({ ...n }));
  const windows = [];
  if (noVocals) windows.push([0, last]);
  else {
    let cursor = 0;
    for (const n of [...line, { startTimeSeconds: last, end: last }]) {
      if (n.startTimeSeconds - cursor >= 2) windows.push([cursor + 0.2, n.startTimeSeconds - 0.1]);
      cursor = Math.max(cursor, n.end);
    }
  }
  const ampMedian = median(inst.map(n => n.amplitude));
  for (const [start, end] of windows) {
    const candidates = inst.filter(n => n.pitch >= 55 && n.amplitude >= 0.5 * ampMedian &&
      n.startTimeSeconds >= start && n.startTimeSeconds < end && Math.min(n.end, end) - n.startTimeSeconds >= 0.2);
    line.push(...trackMelody(groupBy30(candidates)).map(n => ({ ...n, end: Math.min(n.end, end), source: 'instrumental' })));
  }
  line = line.sort((a, b) => a.startTimeSeconds - b.startTimeSeconds).reduce((out, n) => {
    const previous = out.at(-1);
    if (previous && n.startTimeSeconds - previous.startTimeSeconds < 0.16) {
      if (duration(n) * n.amplitude > duration(previous) * previous.amplitude) out[out.length - 1] = n;
    } else out.push(n);
    return out;
  }, []);
  for (let i = 0; i < line.length; i++) {
    const next = line[i + 1], cap = next ? next.startTimeSeconds - 0.015 : Infinity;
    if (next && next.startTimeSeconds - line[i].end <= options.rhLegato / 1000) line[i].end = cap;
    else line[i].end = Math.min(line[i].end, cap);
    line[i].velocity = 0.55 + 0.4 * Math.max(0, Math.min(1, line[i].amplitude));
  }
  const assigned = assignMelodyHands(line, tempo, options);
  const harmony = inferChords(inst, tempo, estimateKey(inst), { melody: assigned.notes });
  const backing = accompaniment(inst, assigned.notes, assigned.phrases, harmony, options);
  const before = filterClashes([...assigned.notes, ...backing]);
  const final = finalizeNotes(before, tempo, { ...options, preset: 'full', maxSounding: 4, minSounding: 100,
    dynamics: false, splitPoint: 60, legatoGap: 0, melodyMinMs: 120, melodyMinIoiMs: 160 });
  const result = enforcePlayability(filterClashes(final), final.estimatedBpm);
  const melody = result.filter(n => n.role === 'melody'), melodyTime = melody.reduce((sum, n) => sum + duration(n), 0);
  for (const key of Object.keys(final)) if (!/^\d+$/.test(key)) result[key] = final[key];
  result.vocalMedianPitch = weightedMedianPitch(vocal.map(n => ({ ...n, pitch: fold(n.pitch) })));
  result.melodyMedianPitch = weightedMedianPitch(melody);
  result.melodyLeftShare = melodyTime ? melody.filter(n => n.hand === 'left').reduce((sum, n) => sum + duration(n), 0) / melodyTime : 0;
  result.noVocals = noVocals;
  result.phrases = assigned.phrases.map(({ notes, ...phrase }) => phrase);
  result.chords = harmony.segments.map(({ bassWeights, ...segment }) => segment);
  for (const n of result) {
    delete n.chordTones;
    delete n.registerLow;
    delete n.registerHigh;
    delete n.placement;
    delete n.phraseMaxPitch;
  }
  return result;
}
