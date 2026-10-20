// Browser, CLI and direct callers share these conversion defaults.
export const pianoDefaults = Object.freeze({
  onsetThresh: 0.5, frameThresh: 0.3, minMs: 80, energyTolerance: 11,
  maxPoly: 6, legato: 0.7, harmonic: 0.6, align: 30, dynamics: true, ghost: 0.35,
  splitAt: 0, preset: 'cover', minSounding: 100, legatoGap: 0,
  keyClean: 0.6, wobble: 0, melody: 3, quantize: true,
});
export function defaultMaxSounding(preset) {
  return preset === 'cover' ? 4 : preset === 'easy' ? 5 : 6;
}

// Krumhansl-Schmuckler profiles and duration-weighted Pearson correlation:
// https://music21.org/music21docs/_modules/music21/analysis/discrete.html
export function estimateKey(notes) {
  const chroma = Array(12).fill(0);
  for (const note of notes) {
    if (!note) continue;
    const pitch = note.pitch ?? note.pitchMidi;
    const duration = note.durationSeconds ?? note.end - note.startTimeSeconds;
    if (Number.isInteger(pitch) && Number.isFinite(duration) && duration > 0) chroma[(pitch % 12 + 12) % 12] += duration;
  }
  const mean = chroma.reduce((sum, time) => sum + time, 0) / 12;
  const variance = chroma.reduce((sum, time) => sum + (time - mean) ** 2, 0);
  if (!variance || !Number.isFinite(variance)) return null;
  const names = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  const profiles = [
    ['major', [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88], [0, 2, 4, 5, 7, 9, 11]],
    ['minor', [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17], [0, 2, 3, 5, 7, 8, 10]],
  ];
  let best;
  for (const [mode, profile, intervals] of profiles) {
    const average = profile.reduce((sum, value) => sum + value, 0) / 12;
    const denominator = Math.sqrt(variance * profile.reduce((sum, value) => sum + (value - average) ** 2, 0));
    for (let tonic = 0; tonic < 12; tonic++) {
      const correlation = chroma.reduce((sum, time, pitch) =>
        sum + (time - mean) * (profile[(pitch - tonic + 12) % 12] - average), 0) / denominator;
      if (!best || correlation > best.correlation) best = {
        name: `${names[tonic]} ${mode}`, tonic, mode,
        scale: intervals.map(interval => (interval + tonic) % 12), correlation,
      };
    }
  }
  return best;
}

// One candidate per nonempty group; retain references so the caller can select the original notes.
export function trackVoice(groups, { intervalWeight = 0.08, preferHigher = true } = {}) {
  groups = groups.filter(group => group.length);
  if (!groups.length) return [];
  const amplitude = note => Math.max(0, Number.isFinite(note.amplitude) ? note.amplitude : 0.5);
  const maximum = groups.reduce((max, group) => group.reduce((value, note) => Math.max(value, amplitude(note)), max), 0) || 1;
  const end = note => note.end ?? note.startTimeSeconds + note.durationSeconds;
  const preferred = (a, b) => preferHigher ? a.pitch > b.pitch : a.pitch < b.pitch;
  const paths = [];
  let costs = [];
  for (let i = 0; i < groups.length; i++) {
    const predecessors = [], next = groups[i].map(note => {
      let best = -amplitude(note) / maximum, predecessor = -1;
      if (i) {
        best = Infinity;
        for (let j = 0; j < groups[i - 1].length; j++) {
          const previous = groups[i - 1][j];
          const cost = costs[j] - amplitude(note) / maximum + intervalWeight * Math.abs(note.pitch - previous.pitch) +
            (note.startTimeSeconds - end(previous) > 1 ? 0.5 : 0);
          if (cost < best - 1e-9 || Math.abs(cost - best) <= 1e-9 &&
            (predecessor < 0 || preferred(previous, groups[i - 1][predecessor]))) {
            best = cost;
            predecessor = j;
          }
        }
      }
      predecessors.push(predecessor);
      return best;
    });
    paths.push(predecessors);
    costs = next;
  }
  let chosen = 0;
  for (let i = 1; i < costs.length; i++) if (costs[i] < costs[chosen] - 1e-9 ||
    Math.abs(costs[i] - costs[chosen]) <= 1e-9 && preferred(groups.at(-1)[i], groups.at(-1)[chosen])) chosen = i;
  const result = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    result.push(groups[i][chosen]);
    chosen = paths[i][chosen];
  }
  return result.reverse();
}

// A skipped group costs 0.6. Subtracting that constant from every group makes
// choosing a note a reward of 0.6 + amplitude; links may skip any number of groups.
export function trackMelody(groups) {
  const nodes = groups.flat();
  if (!nodes.length) return [];
  const amplitude = note => Math.max(0, Number.isFinite(note.amplitude) ? note.amplitude : 0.5);
  const maximum = nodes.reduce((value, note) => Math.max(value, amplitude(note)), 0) || 1;
  const end = note => note.end ?? note.startTimeSeconds + note.durationSeconds;
  const costs = [], from = [], active = [];
  let best = -1, at = 0;
  const low = nodes.reduce((pitch, note) => Math.min(pitch, note.pitch), Infinity);
  const high = nodes.reduce((pitch, note) => Math.max(pitch, note.pitch), -Infinity);
  const maxTransition = 0.08 * (high - low) + 0.5;
  for (const group of groups) {
    const first = at;
    for (const note of group) {
      const reward = 0.6 + amplitude(note) / maximum;
      let cost = -reward, predecessor = -1;
      for (const j of active) {
        const previous = nodes[j];
        const candidate = costs[j] - reward + 0.08 * Math.abs(note.pitch - previous.pitch) +
          (note.startTimeSeconds - end(previous) > 1 ? 0.5 : 0);
        if (candidate < cost - 1e-9 || Math.abs(candidate - cost) <= 1e-9 &&
          (predecessor < 0 || previous.pitch > nodes[predecessor].pitch)) {
          cost = candidate;
          predecessor = j;
        }
      }
      costs.push(cost);
      from.push(predecessor);
      if (best < 0 || cost < costs[best] - 1e-9 ||
        Math.abs(cost - costs[best]) <= 1e-9 && note.pitch > nodes[best].pitch) best = at;
      at++;
    }
    // A path worse than the best by the maximum possible link cost cannot win.
    // Pruning it keeps long songs small without changing the skip-DP objective.
    for (let i = active.length - 1; i >= 0; i--) {
      if (costs[active[i]] > costs[best] + maxTransition + 1e-9) active.splice(i, 1);
    }
    for (let i = first; i < at; i++) active.push(i);
  }
  const line = [];
  for (let i = best; i >= 0; i = from[i]) line.push(nodes[i]);
  return line.reverse();
}

// A 10 ms onset curve keeps the autocorrelation small even for long recordings.
export function estimateTempo(notes) {
  const timed = notes.filter(note => Number.isFinite(note?.startTimeSeconds) && note.startTimeSeconds >= 0 &&
    Number.isFinite(note.end ?? note.startTimeSeconds + note.durationSeconds) &&
    (note.end ?? note.startTimeSeconds + note.durationSeconds) > note.startTimeSeconds);
  const first = timed.reduce((start, note) => Math.min(start, note.startTimeSeconds), Infinity);
  const seconds = timed.reduce((end, note) => Math.max(end, note.end ?? note.startTimeSeconds + note.durationSeconds), 0) - first;
  const fallback = { estimatedBpm: 120, tempoConfidence: 0, phaseConfidence: 0, gridPhaseSeconds: 0,
    gridDeviationMs: timed.length ? 1000 * timed.reduce((sum, note) => sum + Math.abs(note.startTimeSeconds -
      Math.round(note.startTimeSeconds / 0.125) * 0.125), 0) / timed.length : 0, eligible: false };
  // Bound direct callers as well as the CLI's roughly 50-minute decode limit.
  if (seconds < 10 || seconds > 3600 || !Number.isFinite(seconds) || !timed.length) return fallback;
  const bin = 0.01, curve = new Float64Array(Math.ceil(seconds / bin) + 4);
  for (const note of timed) {
    const strength = Math.max(0, Number.isFinite(note.amplitude) ? note.amplitude : 0.5) *
      (Number.isFinite(note.onset) ? Math.max(0.05, note.onset) : 1);
    const at = Math.round((note.startTimeSeconds - first) / bin);
    for (let offset = -2; offset <= 2; offset++) if (at + offset >= 0 && at + offset < curve.length) {
      curve[at + offset] += strength * (3 - Math.abs(offset)) / 3;
    }
  }
  const average = curve.reduce((sum, value) => sum + value, 0) / curve.length;
  for (let i = 0; i < curve.length; i++) curve[i] -= average;
  const scores = new Map();
  for (let lag = Math.floor(60 / 180 / bin); lag <= Math.ceil(60 / 60 / bin); lag++) {
    let cross = 0, a = 0, b = 0;
    for (let i = lag; i < curve.length; i++) {
      cross += curve[i] * curve[i - lag];
      a += curve[i] ** 2;
      b += curve[i - lag] ** 2;
    }
    scores.set(lag, a && b ? cross / Math.sqrt(a * b) : 0);
  }
  let best = [...scores].sort((a, b) => b[1] - a[1])[0];
  // Double/half-time ambiguity is common; prefer its ordinary practising range.
  if (60 / (best[0] * bin) < 70 || 60 / (best[0] * bin) > 150) {
    for (const factor of [0.5, 2]) {
      const around = Math.round(best[0] * factor);
      const candidate = [around - 1, around, around + 1].map(lag => [lag, scores.get(lag) ?? -1]).sort((a, b) => b[1] - a[1])[0];
      const bpm = 60 / (candidate[0] * bin);
      if (bpm >= 70 && bpm <= 150 && candidate[1] >= Math.max(0.12, best[1] * 0.6)) best = candidate;
    }
  }
  const confidence = Math.max(0, best[1]);
  if (confidence < 0.12) return { ...fallback, tempoConfidence: confidence };
  const [lag, peak] = best, before = scores.get(lag - 1) ?? peak, after = scores.get(lag + 1) ?? peak;
  const correction = before - 2 * peak + after ? Math.max(-0.5, Math.min(0.5, 0.5 * (before - after) / (before - 2 * peak + after))) : 0;
  const centre = Math.max(60, Math.min(180, 60 / ((lag + correction) * bin)));
  // Refine the autocorrelation bin: a small BPM rounding error drifts across a song.
  const refine = centre => {
    let bpm = centre, phase = 0, bestPhase = -Infinity;
    for (let p = -100; p <= 100; p++) {
      const candidate = Math.max(60, Math.min(180, centre * (1 + p / 10000))), step = 60 / candidate / 4;
      let real = 0, imaginary = 0, total = 0;
      for (const note of timed) {
        const weight = Math.max(0, Number.isFinite(note.amplitude) ? note.amplitude : 0.5) *
          (Number.isFinite(note.onset) ? Math.max(0.05, note.onset) : 1);
        const angle = 2 * Math.PI * (note.startTimeSeconds - first) / step;
        real += weight * Math.cos(angle); imaginary += weight * Math.sin(angle); total += weight;
      }
      const score = total ? Math.hypot(real, imaginary) / total : 0;
      if (score > bestPhase) {
        bestPhase = score; bpm = candidate;
        phase = ((Math.atan2(imaginary, real) / (2 * Math.PI) % 1 + 1) % 1) * step;
      }
    }
    return { bpm, phase, bestPhase };
  };
  let chosen = refine(centre);
  // A clear phase advantage can resolve an octave missed by the coarse lag bins.
  for (const factor of [2, 0.5]) {
    const alternative = centre * factor;
    if (alternative < 60 || alternative > 180) continue;
    const refined = refine(alternative);
    if (refined.bestPhase >= 1.5 * chosen.bestPhase) chosen = refined;
  }
  let { bpm, phase, bestPhase } = chosen;
  const step = 60 / bpm / 4;
  phase = (phase + first) % step;
  const deviation = timed.reduce((sum, note) => sum + Math.abs(note.startTimeSeconds - phase -
    Math.round((note.startTimeSeconds - phase) / step) * step), 0) / timed.length;
  if (bestPhase < 0.2) return { ...fallback, tempoConfidence: confidence, phaseConfidence: bestPhase };
  return { estimatedBpm: bpm, tempoConfidence: confidence, phaseConfidence: bestPhase, gridPhaseSeconds: phase, gridDeviationMs: deviation * 1000, eligible: true };
}

export function quantizeNotes(notes, timing, { preset = 'full', enabled = true } = {}) {
  const metadata = { ...timing, estimatedBpm: enabled && timing.eligible ? timing.estimatedBpm : 120,
    quantized: false, quantizedNotes: 0, timingOffsetSeconds: 0 };
  if (!enabled || !timing.eligible || !notes.length) return { ...metadata, notes: notes.map(note => ({ ...note })) };
  const step = 60 / timing.estimatedBpm / 4, minimum = Math.max(step, 0.08);
  const first = notes.reduce((start, note) => Math.min(start, note.startTimeSeconds), Infinity);
  // Shift less than a sixteenth so exported beat ticks start at grid zero.
  const offset = timing.gridPhaseSeconds <= first ? timing.gridPhaseSeconds : timing.gridPhaseSeconds - step;
  const original = notes.map(note => ({ ...note, startTimeSeconds: note.startTimeSeconds - offset, end: note.end - offset }));
  const result = original.map(note => {
    const startTimeSeconds = Math.max(0, Math.round(note.startTimeSeconds / step) * step);
    return { ...note, startTimeSeconds, end: Math.max(startTimeSeconds + minimum, Math.round(note.end / step) * step) };
  });
  const protectedNotes = new Set();
  const byStart = original.map((_, i) => i).sort((a, b) => original[a].startTimeSeconds - original[b].startTimeSeconds);
  const rank = new Map(byStart.map((index, position) => [index, position]));
  const protectOne = index => {
    if (protectedNotes.has(index)) return false;
    protectedNotes.add(index); result[index] = { ...original[index] }; return true;
  };
  // Reverting only a re-strike tears its chord away from the partners still on the grid.
  const protect = index => {
    let changed = false;
    const position = rank.get(index), start = original[index].startTimeSeconds;
    for (let i = position; i >= 0 && start - original[byStart[i]].startTimeSeconds <= 0.03 + 1e-9; i--) {
      changed = protectOne(byStart[i]) || changed;
    }
    for (let i = position + 1; i < byStart.length && original[byStart[i]].startTimeSeconds - start <= 0.03 + 1e-9; i++) {
      changed = protectOne(byStart[i]) || changed;
    }
    return changed;
  };
  let changed;
  do {
    changed = false;
    const byPitch = new Map();
    for (const i of byStart) {
      const last = byPitch.get(result[i].pitch);
      if (last !== undefined) {
        const gap = result[i].startTimeSeconds - result[last].end;
        const oldGap = original[i].startTimeSeconds - original[last].end;
        if (gap < -1e-9 || oldGap > 0.05 + 1e-9 && gap <= 0.05 + 1e-9) {
          // Keep re-strikes that cannot fit on the grid, rather than merge attacks.
          const release = result[i].startTimeSeconds - step;
          if (!protectedNotes.has(last) && release - result[last].startTimeSeconds >= minimum - 1e-9 &&
            Math.abs(release / step - Math.round(release / step)) < 1e-7) result[last].end = release;
          else { changed = protect(last) || changed; changed = protect(i) || changed; }
        }
      }
      byPitch.set(result[i].pitch, i);
    }
    // Mixing protected and snapped attacks must not reverse their original order.
    for (const hand of [undefined, 'left', 'right']) {
      const order = hand ? byStart.filter(index => original[index].hand === hand) : byStart;
      for (let i = 1; i < order.length; i++) {
        const previous = order[i - 1], current = order[i];
        if (original[current].startTimeSeconds - original[previous].startTimeSeconds > 0.03 + 1e-9 &&
          result[current].startTimeSeconds < result[previous].startTimeSeconds - 1e-9) {
          changed = protect(previous) || changed;
          changed = protect(current) || changed;
        }
      }
    }
    const order = result.map((_, i) => i).sort((a, b) => result[a].startTimeSeconds - result[b].startTimeSeconds);
    for (let i = 0; i < order.length;) {
      let end = i + 1;
      while (end < order.length && result[order[end]].startTimeSeconds - result[order[i]].startTimeSeconds <= 0.03 + 1e-9) end++;
      const group = order.slice(i, end);
      for (const hand of ['left', 'right']) {
        const voice = group.filter(index => result[index].hand === hand);
        const pitches = voice.map(index => result[index].pitch);
        const limit = preset === 'easy' ? 1 : preset === 'cover' ? hand === 'right' ? 1 : 3 : 5;
        if (voice.length > limit || pitches.length && Math.max(...pitches) - Math.min(...pitches) > 14) {
          for (const index of group) changed = protect(index) || changed;
        }
      }
      i = end;
    }
  } while (changed);
  return { ...metadata, notes: result.sort((a, b) => a.startTimeSeconds - b.startTimeSeconds),
    quantized: true, quantizedNotes: result.length - protectedNotes.size, timingOffsetSeconds: offset };
}

export function toPianoNotes(notes, options = {}) {
  const settings = { ...pianoDefaults };
  for (const [key, value] of Object.entries(options)) if (value !== undefined) settings[key] = value;
  const {
    maxPoly, legato, harmonic, align, dynamics, ghost, splitAt, preset, minSounding, legatoGap,
    maxSounding = defaultMaxSounding(preset), keyClean, wobble, melody, quantize,
  } = settings;
  const sorted = notes.filter(note => note && Number.isFinite(note.pitchMidi) &&
    Number.isFinite(note.startTimeSeconds) && note.startTimeSeconds >= 0 &&
    Number.isFinite(note.durationSeconds) && note.durationSeconds > 0 &&
    Number.isFinite(note.startTimeSeconds + note.durationSeconds) &&
    note.startTimeSeconds + note.durationSeconds > note.startTimeSeconds).map(note => {
    let pitch = Math.round(note.pitchMidi);
    // Fold in constant time, including unusually large pitches from direct callers.
    if (pitch < 21) pitch = 21 + ((pitch - 21) % 12 + 12) % 12;
    if (pitch > 108) pitch = 97 + ((pitch - 97) % 12 + 12) % 12;
    return {
      pitch,
      startTimeSeconds: note.startTimeSeconds,
      end: note.startTimeSeconds + note.durationSeconds,
      amplitude: Number.isFinite(note.amplitude) ? note.amplitude : 0.5,
      onset: Number.isFinite(note.onset) ? note.onset : undefined,
    };
  }).sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);

  const merged = [];
  const previousByPitch = new Map();
  for (const note of sorted) {
    const previous = previousByPitch.get(note.pitch);
    // Preserve real re-strikes; join weak fragments across gaps of at most 80 ms.
    // The slack avoids treating frame-math noise as an overlap or an oversized gap.
    const overlaps = previous && note.startTimeSeconds < previous.end - 1e-9;
    const fragment = previous && legato > 0 && Number.isFinite(note.onset) &&
      note.onset < legato && note.startTimeSeconds - previous.end <= 0.08 + 1e-9;
    if (overlaps || fragment) {
      previous.end = Math.max(previous.end, note.end);
      previous.amplitude = Math.max(previous.amplitude, note.amplitude);
    } else {
      merged.push(note);
      previousByPitch.set(note.pitch, note);
    }
  }

  const ghosts = new Set();
  if (harmonic > 0) {
    let firstNear = 0;
    for (const note of merged) {
      while (merged[firstNear].startTimeSeconds < note.startTimeSeconds - 0.03 - 1e-9) firstNear++;
      for (let i = firstNear; i < merged.length && merged[i].startTimeSeconds <= note.startTimeSeconds + 0.03 + 1e-9; i++) {
        const lower = merged[i];
        if (![12, 19, 24].includes(note.pitch - lower.pitch) || !(note.amplitude < harmonic * lower.amplitude)) continue;
        const overlap = Math.min(note.end, lower.end) - Math.max(note.startTimeSeconds, lower.startTimeSeconds);
        if (overlap >= 0.6 * (note.end - note.startTimeSeconds) - 1e-9) {
          ghosts.add(note);
          break;
        }
      }
    }
  }

  const chords = [];
  for (let i = 0; i < merged.length;) {
    let end = i + 1;
    while (end < merged.length &&
      merged[end].startTimeSeconds - merged[i].startTimeSeconds <= 0.03) end++;
    // Keep the original chord-group anchors through cleanup and alignment.
    chords.push(merged.slice(i, end).filter(note => !ghosts.has(note)));
    i = end;
  }

  const percentile = (values, p) => {
    if (!values.length) return 0;
    const index = (values.length - 1) * p, lo = Math.floor(index), hi = Math.ceil(index);
    return values[lo] + (values[hi] - values[lo]) * (index - lo);
  };
  const selected = chords.flat();
  const quiet = new Set();
  const key = keyClean > 0 ? estimateKey(selected) : null;
  if (ghost > 0 || key) {
    let firstLocal = 0, lastLocal = 0;
    for (const note of selected) {
      while (selected[firstLocal].startTimeSeconds < note.startTimeSeconds - 1 - 1e-9) firstLocal++;
      while (lastLocal < selected.length && selected[lastLocal].startTimeSeconds <= note.startTimeSeconds + 1 + 1e-9) lastLocal++;
      const short = note.end - note.startTimeSeconds < 0.15 - 1e-9;
      const foreign = key && !key.scale.includes(note.pitch % 12) &&
        note.end - note.startTimeSeconds < 0.2 - 1e-9;
      if (!(ghost > 0 && short) && !foreign) continue;
      const local = selected.slice(firstLocal, lastLocal).map(n => n.amplitude).sort((a, b) => a - b);
      const median = percentile(local, 0.5);
      if (short && note.amplitude < ghost * median || foreign && note.amplitude < keyClean * median) quiet.add(note);
    }
  }

  const aligned = [], previousEnds = new Map();
  for (const chord of chords) {
    const audible = chord.filter(note => !quiet.has(note));
    for (let i = 0; i < audible.length;) {
      let end = i + 1;
      if (align > 0) {
        const pitches = new Set([audible[i].pitch]);
        while (end < audible.length && !pitches.has(audible[end].pitch) &&
          audible[end].startTimeSeconds - audible[i].startTimeSeconds <= align / 1000 + 1e-9) {
          pitches.add(audible[end].pitch);
          end++;
        }
      }
      const group = audible.slice(i, end);
      // A shared start must not cross a previous re-strike's release; keep every original end.
      const start = Math.max(group[0].startTimeSeconds, ...group.map(note => previousEnds.get(note.pitch) ?? 0));
      for (const note of group) {
        if (align > 0) {
          note.startTimeSeconds = start;
          note.end = Math.max(note.end, start + 0.001);
        }
        previousEnds.set(note.pitch, note.end);
        aligned.push(note);
      }
      i = end;
    }
  }

  const pitches = aligned.map(note => note.pitch).sort((a, b) => a - b);
  const splitPoint = splitAt || Math.min(72, Math.max(48, pitches.length ? percentile(pitches, 0.5) : 60));
  const violations = hand => Number(hand.length > 5) +
    Number(hand.length > 1 && hand.at(-1).pitch - hand[0].pitch > 14);
  aligned.sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);
  const tempo = estimateTempo(aligned);
  let kept = aligned, previousCount, playabilityDrops = 0;
  do {
    previousCount = kept.length;
    const playable = new Set();
    for (let i = 0; i < kept.length;) {
      let end = i + 1;
      while (end < kept.length && kept[end].startTimeSeconds - kept[i].startTimeSeconds <= 0.03 + 1e-9) end++;
      const group = kept.slice(i, end).sort((a, b) => a.pitch - b.pitch);
      const natural = group.filter(note => note.pitch < splitPoint).length;
      let best;
      for (let k = 0; k <= group.length; k++) {
        const count = violations(group.slice(0, k)) + violations(group.slice(k));
        // Distance to the gap between hands; a valid natural split wins ties.
        const distance = Math.max(0, (group[k - 1]?.pitch ?? -Infinity) - splitPoint,
          splitPoint - (group[k]?.pitch ?? Infinity));
        const shift = Math.abs(k - natural);
        if (!best || count < best.count || count === best.count &&
          (distance < best.distance || distance === best.distance && shift < best.shift)) {
          best = { k, count, distance, shift };
        }
      }
      const hands = [group.slice(0, best.k), group.slice(best.k)];
      for (let h = 0; h < hands.length; h++) {
        const hand = hands[h];
        while (violations(hand)) {
          let quietest = 0;
          for (let j = 1; j < hand.length; j++) if (hand[j].amplitude < hand[quietest].amplitude) quietest = j;
          hand.splice(quietest, 1);
          playabilityDrops++;
        }
        for (const note of hand) {
          note.hand = h ? 'right' : 'left';
          note.chord = hand.length > 1;
          playable.add(note);
        }
      }
      i = end;
    }
    // Full uses the total cap here; arrangements need every candidate before choosing voices.
    kept = chords.flatMap(chord => chord.filter(note => playable.has(note))
      .sort((a, b) => b.amplitude - a.amplitude).slice(0, preset === 'full' ? maxPoly : Infinity))
      .sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);
    if (wobble > 0) {
      const removed = new Set();
      for (const hand of ['left', 'right']) {
        const line = kept.filter(note => note.hand === hand), attacks = [];
        for (let i = 0; i < line.length;) {
          let end = i + 1;
          while (end < line.length && line[end].startTimeSeconds - line[i].startTimeSeconds <= 0.03 + 1e-9) end++;
          attacks.push(end === i + 1 ? line[i] : null); // Chords break a wobble run.
          i = end;
        }
        for (let i = 0; i + 2 < attacks.length; i++) {
          const a = attacks[i], b = attacks[i + 1];
          if (!a || !b || Math.abs(a.pitch - b.pitch) !== 1 ||
            b.startTimeSeconds - a.startTimeSeconds > wobble / 1000 + 1e-9) continue;
          let end = i + 2;
          while (end < attacks.length && attacks[end] && attacks[end].pitch === attacks[end - 2].pitch &&
            attacks[end].startTimeSeconds - attacks[end - 1].startTimeSeconds <= wobble / 1000 + 1e-9) end++;
          if (end - i < 3) continue;
          const run = attacks.slice(i, end), sides = [a.pitch, b.pitch].map(pitch => run.filter(note => note.pitch === pitch));
          const times = sides.map(notes => notes.reduce((sum, note) => sum + note.end - note.startTimeSeconds, 0));
          if (Math.abs(times[0] - times[1]) < 1e-9) continue;
          const winner = times[0] > times[1] ? 0 : 1;
          if (Math.max(...sides[1 - winner].map(note => note.end - note.startTimeSeconds)) >
            Math.max(...sides[winner].map(note => note.end - note.startTimeSeconds)) + 1e-9) continue;
          const note = sides[winner][0], start = a.startTimeSeconds, finish = Math.max(...run.map(note => note.end));
          // Preserve other re-strikes, including same-pitch notes in the opposite hand.
          if (kept.some(other => !run.includes(other) && other.pitch === note.pitch &&
            other.end >= start - 0.05 - 1e-9 && other.startTimeSeconds <= finish + 0.05 + 1e-9)) continue;
          note.startTimeSeconds = start;
          note.end = finish;
          note.amplitude = Math.max(...run.map(note => note.amplitude));
          note.onset = a.onset;
          for (const other of run) if (other !== note) removed.add(other);
          i = end - 1;
        }
      }
      kept = kept.filter(note => !removed.has(note)).sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);
    }
    // A removed anchor can join neighbouring groups; reassign until no more notes disappear.
  } while (kept.length < previousCount);

  let arrangementBass;
  if (preset === 'easy' || preset === 'cover') {
    const scale = estimateKey(kept)?.scale ?? [];
    let previousArrangement, strongNotes;
    do {
      previousArrangement = kept.length;
      const groups = [];
      for (let i = 0; i < kept.length;) {
        let end = i + 1;
        while (end < kept.length && kept[end].startTimeSeconds - kept[i].startTimeSeconds <= 0.03 + 1e-9) end++;
        groups.push(kept.slice(i, end));
        i = end;
      }
      const right = groups.map(group => group.filter(note => note.hand === 'right'));
      const left = groups.map(group => group.filter(note => note.hand === 'left'));
      const top = group => group.reduce((best, note) => !best || note.pitch > best.pitch ? note : best, null);
      const bottom = group => group.reduce((best, note) => !best || note.pitch < best.pitch ? note : best, null);
      const melodyLine = melody > 0 ? trackMelody(right) : right.map(top).filter(Boolean);
      const bassLine = preset === 'cover' ? trackVoice(left, { intervalWeight: 0.04, preferHigher: false })
        : left.map(bottom).filter(Boolean);
      const chosen = new Set([...melodyLine, ...bassLine]);
      if (preset === 'cover') {
        // Rank the original groups once; removing notes must not promote a weak onset.
        strongNotes ??= new Set(groups.map((group, i) => ({ i, strength: group.reduce((sum, note) => sum + note.amplitude, 0) }))
          .sort((a, b) => b.strength - a.strength || a.i - b.i).slice(0, Math.ceil(groups.length * 0.4)).flatMap(group => groups[group.i]));
        for (let i = 0; i < groups.length; i++) {
          for (const note of left[i].filter(note => strongNotes.has(note) && !chosen.has(note) && scale.includes(note.pitch % 12))
            .sort((a, b) => b.amplitude - a.amplitude || a.pitch - b.pitch).slice(0, 2)) chosen.add(note);
        }
      }
      arrangementBass = new Set(bassLine);
      const voices = new Set([...melodyLine, ...bassLine]);
      kept = groups.flatMap(group => group.filter(note => chosen.has(note) &&
        (preset !== 'easy' || note.end - note.startTimeSeconds >= 0.12 - 1e-9))
        .sort((a, b) => Number(voices.has(b)) - Number(voices.has(a)) || b.amplitude - a.amplitude).slice(0, maxPoly))
        .sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);
      for (const group of groups) for (const note of group) {
        note.chord = group.filter(other => chosen.has(other) && other.hand === note.hand).length > 1;
      }
      // Removing an early attack can join neighbouring groups; choose again until stable.
    } while (kept.length < previousArrangement);
  }

  if (preset === 'cover') {
    const beat = quantize && tempo.eligible ? 60 / tempo.estimatedBpm : 0.3;
    const phase = quantize && tempo.eligible ? tempo.gridPhaseSeconds : 0;
    const selectedLeft = new Set();
    let previousBass, previousBeat, previousChord;
    for (const note of kept.filter(note => arrangementBass.has(note))) {
      const bucket = Math.floor((note.startTimeSeconds - phase) / beat + 1e-9);
      if (bucket === previousBeat || previousBass && previousBass.pitch % 12 === note.pitch % 12 &&
        previousBass.end > note.startTimeSeconds) continue;
      selectedLeft.add(note);
      previousBeat = bucket;
      previousBass = note;
    }
    for (let i = 0; i < kept.length;) {
      let end = i + 1;
      while (end < kept.length && kept[end].startTimeSeconds - kept[i].startTimeSeconds <= 0.03 + 1e-9) end++;
      const left = kept.slice(i, end).filter(note => note.hand === 'left');
      const signature = [...new Set(left.map(note => note.pitch % 12))].sort((a, b) => a - b).join(',');
      // Chord changes accompany a retained bass attack, not every detected transient.
      if (signature !== previousChord && left.some(note => selectedLeft.has(note))) {
        for (const note of left) if (!arrangementBass.has(note)) selectedLeft.add(note);
        previousChord = signature;
      }
      for (const note of left) note.chord = left.filter(other => selectedLeft.has(other)).length > 1;
      i = end;
    }
    kept = kept.filter(note => note.hand === 'right' || selectedLeft.has(note));
  }

  const nextByPitch = new Map(), nextByHand = new Map();
  for (let i = kept.length - 1; i >= 0; i--) {
    const note = kept[i], originalEnd = note.end;
    const nextPitch = nextByPitch.get(note.pitch), nextHand = nextByHand.get(note.hand);
    const pitchGap = nextPitch ? nextPitch.startTimeSeconds - originalEnd : Infinity;
    const extendTo = end => {
      end = Math.max(note.end, Math.min(end, nextPitch ? nextPitch.startTimeSeconds - 0.001 : Infinity));
      // Preserve real re-strike spacing: do not create another <=50 ms fragment pair.
      if (pitchGap <= 0.05 + 1e-9 || !nextPitch || nextPitch.startTimeSeconds - end > 0.05 + 1e-9) note.end = end;
    };
    if (minSounding > 0 && pitchGap > 0.12 + 1e-9 && originalEnd - note.startTimeSeconds < minSounding / 1000) {
      extendTo(note.startTimeSeconds + minSounding / 1000);
    }
    const gap = nextHand ? nextHand.startTimeSeconds - note.end : Infinity;
    if (!note.chord && legatoGap > 0 && gap >= 0.001 - 1e-9 && gap <= legatoGap / 1000 + 1e-9) {
      extendTo(Math.min(nextHand.startTimeSeconds, originalEnd + 0.15));
    }
    nextByPitch.set(note.pitch, note);
    nextByHand.set(note.hand, note);
  }

  const releaseSustains = () => {
    if (!(maxSounding > 0)) return;
    let sounding = [];
    for (let i = 0; i < kept.length;) {
      const start = kept[i].startTimeSeconds;
      let end = i + 1;
      while (end < kept.length && kept[end].startTimeSeconds - start <= 0.03 + 1e-9) end++;
      const group = kept.slice(i, end), hands = new Set(group.map(note => note.hand));
      sounding = sounding.filter(note => note.end > start + 1e-9);
      const release = start - 0.001;
      const candidates = sounding.filter(note => release - note.startTimeSeconds >= 0.06 - 1e-9)
        .sort((a, b) => Number(hands.has(b.hand)) - Number(hands.has(a.hand)) ||
          a.startTimeSeconds - b.startTimeSeconds || a.amplitude - b.amplitude);
      let excess = sounding.length + group.length - maxSounding;
      for (const note of candidates) {
        if (excess <= 0) break;
        note.end = release;
        excess--;
      }
      // New attacks and notes younger than 60 ms take priority over the cap.
      sounding = sounding.filter(note => note.end > start + 1e-9).concat(group);
      i = end;
    }
  };
  releaseSustains();
  const timing = quantizeNotes(kept, tempo, { preset, enabled: quantize });
  kept = timing.notes;
  delete timing.notes;
  releaseSustains();

  const amplitudes = kept.map(note => note.amplitude).sort((a, b) => a - b);
  const p5 = percentile(amplitudes, 0.05), p95 = percentile(amplitudes, 0.95);
  const result = kept.sort((a, b) => a.startTimeSeconds - b.startTimeSeconds).map(note => ({
    pitch: note.pitch,
    hand: note.hand,
    startTimeSeconds: note.startTimeSeconds,
    durationSeconds: note.end - note.startTimeSeconds,
    amplitude: note.amplitude,
    velocity: dynamics
      ? p95 > p5 ? Math.min(1, Math.max(0.1, 0.35 + 0.6 * (note.amplitude - p5) / (p95 - p5))) : 0.7
      : Math.min(1, Math.max(0.05, note.amplitude)),
    ...(note.onset === undefined ? {} : { onset: note.onset }),
  }));
  return Object.assign(result, { splitPoint, playabilityDrops, ...timing });
}
