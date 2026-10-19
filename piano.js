export function toPianoNotes(notes, {
  maxPoly = 6, legato = 0.65, harmonic = 0.6, align = 30, dynamics = true, ghost = 0.35, splitAt = 0,
  preset = 'full', minSounding = 120, legatoGap = preset === 'easy' ? 150 : 100,
} = {}) {
  const sorted = notes.map(note => {
    let pitch = note.pitchMidi;
    while (pitch < 21) pitch += 12;
    while (pitch > 108) pitch -= 12;
    return {
      pitch,
      startTimeSeconds: note.startTimeSeconds,
      end: note.startTimeSeconds + note.durationSeconds,
      amplitude: note.amplitude,
      onset: note.onset,
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
  if (ghost > 0) {
    let firstLocal = 0, lastLocal = 0;
    for (const note of selected) {
      while (selected[firstLocal].startTimeSeconds < note.startTimeSeconds - 1 - 1e-9) firstLocal++;
      while (lastLocal < selected.length && selected[lastLocal].startTimeSeconds <= note.startTimeSeconds + 1 + 1e-9) lastLocal++;
      if (note.end - note.startTimeSeconds >= 0.15) continue;
      const local = selected.slice(firstLocal, lastLocal).map(n => n.amplitude).sort((a, b) => a - b);
      if (note.amplitude < ghost * percentile(local, 0.5)) quiet.add(note);
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
        // Easy keeps the outer voices before the loudness cap, then discards flickers.
        const arrangement = preset === 'easy'
          ? [hand.at(h ? -1 : 0)].filter(note => note && note.end - note.startTimeSeconds >= 0.12 - 1e-9)
          : hand;
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
