# MP3 to Piano MIDI

A browser-only MP3/audio converter using Spotify Basic Pitch. Audio stays on your device. The result is an approximate piano arrangement, especially for full mixes; it is not a score transcription. Exports use the 88-key range, piano instruments, no pitch bends, and an estimated tempo when beat quantization is accepted (otherwise 120 BPM with original timing).

## Run

Use Node 24. Install dependencies with `npm ci --cache G:\Temp\npm-cache` on this Windows machine; its default npm cache is broken. The model is already in `public/model`.

```sh
npm run dev
npm test
npx vite build
```

Open the URL printed by Vite, choose audio, press **Convert**, then **Download MIDI**. Serve the page over HTTP rather than opening HTML directly. `dist/` is the static build; `.github/workflows/pages.yml` deploys it to GitHub Pages on pushes to `main`.

## Controls

Automatic controls below are configurable through the CLI; the browser exposes the first seven rows.

| Control | What it does | Default |
| --- | --- | --- |
| Arrangement / `--preset` | Full keeps chords; Easy tracks melody plus the lowest bass and drops attacks shorter than 120 ms; Cover tracks melody/bass with sparse chord tones. | `full` |
| Sensitivity / `--onset` | Onset threshold. Lower detects more attacks. | `0.5` |
| Note threshold / `--frame` | Frame threshold. Lower retains quieter sustain. | `0.3` |
| Min note length / `--min` | Minimum detection length, in milliseconds. | `80` |
| Max notes per chord / `--poly` | Keeps the loudest playable notes per original 30 ms attack group. | `6` |
| Split hands / `--no-split` | Writes two piano tracks; disabling writes one without changing the arrangement. | On, automatic |
| Snap to beat grid / `--no-quantize` | Estimates tempo and phase, snapping starts/ends to sixteenths with at least one sixteenth or 80 ms. Skips weak estimates and clips under 10 seconds. | On |
| `--split-at` | Preferred hand boundary: `0` uses the median pitch clamped to MIDI 48–72; otherwise fixes the preferred pitch. | `0` |
| `--tolerance` | Consecutive low-energy model frames tolerated during sustain (one frame ≈11.6 ms). | `11` |
| `--legato` | Joins same-pitch fragments across gaps ≤80 ms when the later onset is weaker than this threshold. | `0.7` |
| `--harmonic` | Removes quieter +12/+19/+24 overtones with starts within 30 ms and ≥60% duration overlap; value is their amplitude ratio to the lower note. | `0.6` |
| `--align` | Aligns attacks within this many milliseconds, preserving endings where possible (1 ms minimum) and same-pitch re-strikes. | `30` |
| `--ghost` | Removes notes shorter than 150 ms below this fraction of the median amplitude within ±1 second. | `0.35` |
| Dynamics / `--no-dynamics` | Maps amplitude percentiles 5–95 to velocities 0.35–0.95, clamped to 0.1–1; constant amplitudes use 0.7. | On |
| `--min-sounding` | Extends isolated short notes to this length, in milliseconds, before the sounding cap. | `100` |
| `--legato-gap` | Fills gaps between single-note attacks in one hand, adding at most 150 ms per note. Disabled by default to allow releases. | `0` |
| `--max-sounding` | Releases older sustains when a chord starts; prefers the incoming hand, then oldest/quietest notes. Protects the first 60 ms of each attack. | Full `6`; Easy `5`; Cover `4` |
| `--key-clean` | Removes out-of-key notes shorter than 200 ms and below this fraction of the local median amplitude within ±1 second. Keeps long or strong chromatic notes. | `0.6` |
| `--wobble` | Joins alternating semitone runs of singleton hand attacks within this many milliseconds; keeps the pitch with more note-time. Chords and nearby re-strikes are protected. | `0` (off) |
| `--melody` | Positive enables the fixed-cost melody tracker in Easy/Cover; zero restores highest-note selection. The numeric flag is retained for compatibility. | `3` (on) |

Set a cleanup/length option to `0` to disable it. `--no-dynamics` restores raw amplitudes clamped to 0.05–1. Tracking chooses one candidate from each nonempty hand group, so isolated wrong pitches can still force jumps; it is not vocal isolation. Full remains the default because Cover missed the five-song jump-rate and density targets.

Each hand is limited to five notes spanning 14 semitones per 30 ms attack group. The boundary may move away from the preferred split; impossible chords lose the quietest offending notes. The sounding cap preserves new attacks and notes younger than 60 ms, so temporary excess polyphony is possible. Sustained notes can still exceed a hand's reach.

A short note is isolated when no same-pitch note starts within 120 ms after its end. Extensions preserve re-strike spacing; multi-note hand attacks skip gap-fill. Beat quantization requires centered onset autocorrelation ≥0.12 and sixteenth-phase concentration ≥0.20. Unsafe re-strikes or newly unplayable groups keep their original relative timing; sounding-cap releases take priority over grid endings/minimums. A common phase shift aligns grid ticks, but does not identify the musical downbeat or meter. `--no-quantize` preserves original timing and 120 BPM.

## Command line

Requires **ffmpeg on PATH** and Node 24:

```sh
node cli.mjs "song.mp3" --out "song.mid" --json
node cli.mjs "song.mp3" --out "song-easy.mid" --preset easy --json
node cli.mjs --help
```

Without `--out`, the MIDI is written beside the input. CPU inference can take several minutes. Model outputs are cached in `.cache/` by basename and size, checked against source path/mtime and model timestamp; parameter changes reuse inference. Delete the matching cache to force inference. Decoding is limited to 256 MiB of mono 22050 Hz float audio (about 50 minutes); split longer files first.

`--json` writes statistics to stdout and progress to stderr. Statistics describe the final arrangement before MIDI tick rounding. Fragments count same-pitch gaps ≤50 ms, including real repeats; chord/hand metrics use anchored 30 ms groups. Sounding metrics cover first onset through last release. Key estimates use duration-weighted [Krumhansl–Schmuckler profiles](https://music21.org/music21docs/_modules/music21/analysis/discrete.html); out-of-key does not necessarily mean wrong. Wobble counts alternating singleton semitone triples ≤150 ms apart. Melody jump rate follows the highest right-hand pitch per group and counts intervals >7 semitones. `estimatedBpm` is the exported tempo; `gridDeviationMs` measures pre-snap starts against the candidate grid (120 BPM grid after rejection). `tempoConfidence` and `phaseConfidence` report the two guards; `quantizedNotes` counts starts accepted for snapping, and `timingOffsetSeconds` records the common shift. Duration percentiles use ms; velocities use 0–1.

## How the arrangement is built

After cleanup and playable hand assignment, Easy/Cover use dynamic programming over right-hand candidates: cost is negative amplitude normalized by the voice maximum, plus 0.08 per semitone travelled and 0.5 for a gap over one second. Ties prefer higher notes. Cover tracks bass similarly with weight 0.04 and lower-pitch ties, adding at most two in-key left-hand tones on the strongest 40% of original groups by summed amplitude. The sounding cap runs before and after guarded beat quantization to protect releases and avoid new fragments.

- `extract.js`: model frames/onsets → timed notes; subtracts one frame from Basic Pitch's exclusive minimum-length cutoff and labels onset-less continuations with zero onset.
- `piano.js`: shared cleanup, voice tracking, tempo estimation, quantization, and dynamics. Removed anchors trigger regrouping. Inputs are unchanged; array metadata carries hand, tempo, and timing diagnostics.
- `midi.js`: hand-labelled notes → explicit ticks at the estimated tempo. Same-tick same-pitch attacks coalesce; earlier notes are clipped at re-strikes to prevent zero lengths and overlaps across tracks.

`main.js` decodes browser audio and reuses one scoped model with WebGL-to-CPU fallback; `cli.mjs` handles ffmpeg, local inference caching, and statistics. `test/piano.test.mjs` checks the shared pipeline, MIDI round trips, and browser controls. Keep module/CLI/HTML defaults aligned. TensorFlow is overridden to 4.22 because 3.21 had a WebGL concat-shader failure. No server is needed in production.

## Getting the MIDI onto a Meta Quest 3

- **PianoVision:** install the [PianoVision desktop app](https://www.pianovision.com/resources/), run PianoVision on the headset, and link the desktop app to the headset on the same network. Upload the `.mid` and fill in the artist and title. It appears under **Imports** in the headset.
- **Other VR piano apps:** connect the Quest by USB, allow file access on the headset, and copy the `.mid` into the app's folder or **Download**, according to the app's import instructions.
- **Hosted page:** open this page in the Quest browser and download the `.mid` straight to the headset. Use the destination app's supported import method; PianoVision's documented workflow uses its desktop app.
