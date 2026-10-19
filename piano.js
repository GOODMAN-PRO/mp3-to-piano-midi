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

export function toPianoNotes(notes, {
  maxPoly = 6, legato = 0.7, harmonic = 0.6, align = 30, dynamics = true, ghost = 0.35, splitAt = 0,
  preset = 'full', minSounding = 100, legatoGap = 0,
  maxSounding = preset === 'easy' ? 5 : 6, keyClean = 0.6, wobble = 0, melody = 3,
} = {}) {
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
  let kept = aligned, previousCount, playabilityDrops = 0;
  do {
    previousCount = kept.length;
    const playable = new Set();
    let previousRightPitch;
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
        // Prefer the top voice, with a modest penalty for large Easy melody jumps.
        let melodyNote = hand.at(-1);
        if (h && preset === 'easy' && melody > 0 && previousRightPitch !== undefined && melodyNote &&
          melodyNote.end - melodyNote.startTimeSeconds >= 0.12 - 1e-9) {
          const score = note => note.pitch - melody * Math.max(0, Math.abs(note.pitch - previousRightPitch) - 7);
          for (const candidate of [...hand].reverse()) {
            if (candidate.end - candidate.startTimeSeconds < 0.12 - 1e-9) continue;
            // Substituting an inner voice must not introduce another same-pitch fragment.
            if (candidate !== hand.at(-1) && aligned.some(other => other !== candidate && other.pitch === candidate.pitch &&
              (candidate.startTimeSeconds - other.end >= -1e-9 && candidate.startTimeSeconds - other.end <= 0.05 + 1e-9 ||
               other.startTimeSeconds - candidate.end >= -1e-9 && other.startTimeSeconds - candidate.end <= 0.05 + 1e-9))) continue;
            if (score(candidate) > score(melodyNote)) melodyNote = candidate;
          }
        }
        const arrangement = preset === 'easy'
          ? [h ? melodyNote : hand.at(0)].filter(note => note && note.end - note.startTimeSeconds >= 0.12 - 1e-9)
          : hand;
        if (h && arrangement.length) previousRightPitch = arrangement[0].pitch;
        for (const note of arrangement) {
          note.hand = h ? 'right' : 'left';
          note.chord = arrangement.length > 1;
          playable.add(note);
        }
      }
      i = end;
    }
    // Apply the total cap to its original groups, after hand assignment.
    kept = chords.flatMap(chord => chord.filter(note => playable.has(note))
      .sort((a, b) => b.amplitude - a.amplitude).slice(0, maxPoly))
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

  if (maxSounding > 0) {
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
  }

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
  return Object.assign(result, { splitPoint, playabilityDrops });
}
