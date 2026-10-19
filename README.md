# MP3 to Piano MIDI

A small, browser-only converter for MP3 or any browser-decodable audio. Spotify Basic Pitch transcribes notes locally; the app folds them into the 88-key piano range, merges overlapping notes of the same pitch, and exports piano MIDI without pitch bends. Audio is never uploaded. Transcription is approximate, especially for full mixes.

## Run

Run `npm install` once (the Basic Pitch model files are already in `public/model`).

```sh
npm run dev
npm run build
```

Open the local URL printed by Vite. The build creates `dist/`, ready for static hosting, including GitHub Pages under a sub-path. Open a served page rather than an HTML file directly. Run `npm test` for the piano-note self-check.

## Controls

- **Sensitivity:** onset threshold; lower values detect more note starts, higher values require stronger starts.
- **Note threshold:** frame threshold; lower values retain quieter note sustain.
- **Arrangement:** Full keeps the chord arrangement. Easy (melody + bass) keeps the highest right-hand note and lowest left-hand note in each 30 ms group, then drops notes shorter than 120 ms before smoothing.
- **Min note length (ms):** filters short detections (default 80 ms).
- **Max simultaneous notes:** keeps the loudest playable notes in each original group starting within 30 ms (default 6), after hand assignment. Sustained notes from earlier groups can still overlap.
- **Split hands (automatic):** two piano tracks, using the song's median pitch (clamped to MIDI 48–72) as the preferred split and adjusting each chord so each hand spans at most 14 semitones and plays at most five notes. Chords that cannot fit lose the quietest notes in the offending hand; uncheck for one piano track with the same playability limits.
- **Note-length smoothing:** isolated short notes are extended to 120 ms, and single-note attacks within a hand join across gaps up to 100 ms (150 ms in Easy). Gap-fill adds at most 150 ms per note and preserves the releases of chords within a hand and same-pitch re-strikes.

Weak-onset fragments of the same pitch are joined across gaps of up to 80 ms before chord limiting. Starts with an onset strength of 0.65 or greater stay separate, preserving stronger repeated notes; overlapping notes still merge as before. This reduces false re-attacks in full mixes, though transcription remains approximate.

Automatic harmonic cleanup removes much quieter overtones sharing a start and most of their duration with a lower note, while keeping strong octave doublings.

Chords are aligned within 30 ms while preserving note endings and separate same-pitch re-strikes; velocities expand the conversion's 5th–95th amplitude percentiles to 0.35–0.95. Short notes below 35% of their local median amplitude are removed, so uniformly soft passages are preserved.

Choose a file, press **Convert**, then **Download MIDI**. The download keeps the original filename with a `.mid` extension.

## Command line

Use Node 24 with **ffmpeg on PATH** and the project's dependencies installed:

```sh
node cli.mjs "song.mp3" --out "song.mid" --json
node cli.mjs "song.mp3" --out "song-easy.mid" --preset easy --json
```

The CLI uses the same extraction, smoothing, and MIDI code as the browser. It decodes to mono 22050 Hz, loads `public/model` locally, and runs inference on the CPU. The first run can take several minutes; model outputs are saved in `.cache/` so changing parameters skips inference. Cache entries are checked against the source path, size, modification time, and model timestamp. Delete the corresponding cache file to force inference again.

Options: `--onset`, `--frame`, `--min` (milliseconds), `--poly`, `--tolerance` (model frames), `--legato` (weak-onset threshold; `0` disables fragment smoothing), `--harmonic` (amplitude ratio; `0` disables harmonic cleanup), `--align` (milliseconds within a chord group; `0` disables), `--ghost` (local amplitude ratio; `0` disables), `--split-at` (`0` for automatic, otherwise a fixed preferred MIDI pitch from 1–127), `--preset` (`full` or `easy`), `--min-sounding` and `--legato-gap` (milliseconds; `0` disables each length-smoothing stage), `--no-dynamics`, and `--no-split`. Run `node cli.mjs --help` for defaults. Without `--out`, MIDI is written beside the input with a `.mid` extension.

Browser and CLI defaults are onset `0.5`, frame `0.3`, minimum `80` ms, polyphony `6`, energy tolerance `11` frames, legato `0.65`, harmonic `0.6`, alignment `30` ms, ghost ratio `0.35`, automatic split (`--split-at 0`), Full arrangement, minimum sounding length `120` ms, legato gap `100` ms, dynamics and split hands enabled. Easy defaults to a `150` ms legato gap unless explicitly overridden. Harmonic cleanup considers notes 12, 19, or 24 semitones above a louder note, with starts within 30 ms and at least 60% duration overlap.

Alignment uses the earliest chord start that does not overlap a previous note of the same pitch, preserving original ends with a minimum duration of 1 ms. Dynamics uses one linear percentile mapping clamped to 0.1–1, or 0.7 when the percentile range is constant; `--no-dynamics` restores the raw amplitude clamp. Quiet cleanup compares notes shorter than 150 ms against the median raw amplitude of notes starting within ±1 second, before alignment and velocity mapping. Use `--align 0 --ghost 0 --no-dynamics` to disable these three stages.

Hand assignment follows cleanup and alignment, before the total chord cap. A forced split fixes the preferred pitch rather than disabling hand limits: notes below it favour the left hand, notes at or above it favour the right, and a chord's boundary can move to fit both hands. These limits apply to 30 ms attack groups; sustained notes from earlier groups can still exceed a hand's reach or finger count.

Length smoothing follows arrangement selection and leaves all note starts unchanged. A short note is isolated when no same-pitch note starts within 120 ms after its original end. Extensions stop at least 1 ms before the next same-pitch note, and are skipped if they would turn a gap above 50 ms into an additional fragment pair. Multi-note attacks within a hand skip gap-fill; isolated short chord tones can still receive the minimum sounding length. `--preset full --min-sounding 0 --legato-gap 0` restores loop-3 output; Easy's 120 ms short-note filter remains active when smoothing is disabled.

Statistics include note count, last note end in seconds, notes/second, median duration, percentage under 100 ms, same-pitch pairs separated by at most 50 ms, their later notes' mean onset strength, and peak sounding notes. Strong repeated notes also count in the fragment statistic. `--json` prints one JSON object to stdout; progress goes to stderr.

`harmonicPairs` counts upper notes with a note 12, 19, or 24 semitones below starting within 30 ms; `harmonicPairsWeak` counts those below 0.6 times a qualifying lower note's raw amplitude, regardless of duration overlap.

`chordGroups` counts groups of at least two notes starting within 30 ms of the first note, and `meanChordSpreadMs` measures their average start spread. `velocityP5`, `velocityP50`, and `velocityP95` describe final velocities before MIDI quantization; `quietShortNotes` counts remaining notes shorter than 150 ms and below 0.35 times their local median raw amplitude.

`leftNotes` and `rightNotes` count final hand assignments; `splitPoint` reports the preferred pitch used. `handSpanViolations` and `handPolyViolations` count final 30 ms groups where either hand exceeds 14 semitones or five notes, respectively. `playabilityDrops` counts notes removed by hand limits, separately from the total chord cap; `--no-split` changes only the number of MIDI tracks.

`isolatedShortNotes` counts notes shorter than 120 ms with no same-pitch start within 120 ms after their end. `sameHandGapsUnder100ms` counts gaps of 1–100 ms between consecutive notes ordered by start within each hand. `durationP10`, `durationP50`, `durationP90`, and `maxDurationMs` report final note lengths in milliseconds.

## Getting the MIDI onto a Meta Quest 3

- **PianoVision:** install the [PianoVision desktop app](https://www.pianovision.com/resources/), run PianoVision on the headset, and link the desktop app to the headset on the same network. Upload the `.mid` and fill in the artist and title. It appears under **Imports** in the headset.
- **Other VR piano apps:** connect the Quest by USB, allow file access on the headset, and copy the `.mid` into the app's folder or **Download**, according to the app's import instructions.
- **Hosted page:** open this page in the Quest browser and download the `.mid` straight to the headset. Use the destination app's supported import method; PianoVision's documented workflow uses its desktop app.
