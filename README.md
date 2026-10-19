# MP3 to Piano MIDI

A browser-only MP3/audio converter using Spotify Basic Pitch. Audio stays on your device. The result is an approximate piano arrangement, especially for full mixes; it is not a score transcription. Exports use the 88-key range, piano instruments, no pitch bends, and a 120 BPM tempo event while preserving timing in seconds.

## Run

Use Node 24. Install dependencies with `npm ci --cache G:\Temp\npm-cache` on this Windows machine; its default npm cache is broken. The model is already in `public/model`.

```sh
npm run dev
npm test
npx vite build
```

Open the URL printed by Vite, choose audio, press **Convert**, then **Download MIDI**. Serve the page over HTTP rather than opening HTML directly. `dist/` is the static build; `.github/workflows/pages.yml` deploys it to GitHub Pages on pushes to `main`.

## Controls

Automatic controls below are configurable through the CLI; the browser exposes the first six rows.

| Control | What it does | Default |
| --- | --- | --- |
| Arrangement / `--preset` | Full keeps chords; Easy keeps the highest right-hand and lowest left-hand note per group, then drops notes shorter than 120 ms. | `full` |
| Sensitivity / `--onset` | Onset threshold. Lower detects more attacks. | `0.5` |
| Note threshold / `--frame` | Frame threshold. Lower retains quieter sustain. | `0.3` |
| Min note length / `--min` | Minimum detection length, in milliseconds. | `80` |
| Max simultaneous notes / `--poly` | Keeps the loudest playable notes per original 30 ms attack group. | `6` |
| Split hands / `--no-split` | Writes two piano tracks; disabling writes one without changing the arrangement. | On, automatic |
| `--split-at` | Preferred hand boundary: `0` uses the median pitch clamped to MIDI 48–72; otherwise fixes the preferred pitch. | `0` |
| `--tolerance` | Consecutive low-energy model frames tolerated during sustain (one frame ≈11.6 ms). | `11` |
| `--legato` | Joins same-pitch fragments across gaps ≤80 ms when the later onset is weaker than this threshold. | `0.7` |
| `--harmonic` | Removes quieter +12/+19/+24 overtones with starts within 30 ms and ≥60% duration overlap; value is their amplitude ratio to the lower note. | `0.6` |
| `--align` | Aligns attacks within this many milliseconds, preserving endings where possible (1 ms minimum) and same-pitch re-strikes. | `30` |
| `--ghost` | Removes notes shorter than 150 ms below this fraction of the median amplitude within ±1 second. | `0.35` |
| Dynamics / `--no-dynamics` | Maps amplitude percentiles 5–95 to velocities 0.35–0.95, clamped to 0.1–1; constant amplitudes use 0.7. | On |
| `--min-sounding` | Extends isolated short notes to this length, in milliseconds. | `120` |
| `--legato-gap` | Fills gaps between single-note attacks in one hand, adding at most 150 ms per note. | `100`; Easy `150` |

Set `--legato`, `--harmonic`, `--align`, `--ghost`, `--min-sounding`, or `--legato-gap` to `0` to disable that stage. `--no-dynamics` restores raw amplitudes clamped to 0.05–1.

Each hand is limited to five notes spanning 14 semitones per 30 ms attack group. The boundary may move away from the preferred split; impossible chords lose the quietest offending notes. These are attack-group limits: sustained notes from earlier groups can still exceed the total cap or a hand's reach.

A short note is isolated when no same-pitch note starts within 120 ms after its end. Extensions stop at least 1 ms before the next same-pitch note and are skipped if they would create an additional ≤50 ms fragment pair. Multi-note attacks within a hand skip gap-fill. Strong repeated notes stay separate; stronger fragment merging can also join some genuine softer re-strikes.

## Command line

Requires **ffmpeg on PATH** and Node 24:

```sh
node cli.mjs "song.mp3" --out "song.mid" --json
node cli.mjs "song.mp3" --out "song-easy.mid" --preset easy --json
node cli.mjs --help
```

Without `--out`, the MIDI is written beside the input. CPU inference can take several minutes. Model outputs are cached in `.cache/` by basename and size, checked against source path/mtime and model timestamp; parameter changes reuse inference. Delete the matching cache to force inference. Decoding is limited to 256 MiB of mono 22050 Hz float audio (about 50 minutes); split longer files first.

`--json` writes one statistics object to stdout; progress goes to stderr. Statistics describe notes before MIDI tick/velocity quantization. Fragments count same-pitch pairs with gaps ≤50 ms, including genuine repeats. Chord spread and hand violations use 30 ms groups anchored at the first note. Peak sounding counts all overlapping sustains. `harmonicPairsWeak` uses amplitude ratio 0.6 and `quietShortNotes` uses 0.35 regardless of cleanup settings. Duration percentiles are in milliseconds; velocity percentiles are in 0–1 units.

## Code map

`main.js` decodes/resamples browser audio and lazily reuses one model, with TensorFlow scopes and a WebGL-to-CPU fallback. `cli.mjs` provides ffmpeg decoding, local model loading, inference caching, and statistics. Both use the same three modules:

- `extract.js`: model frames/onsets → timed notes; subtracts one frame from Basic Pitch's exclusive minimum-length cutoff and labels onset-less continuations with zero onset.
- `piano.js`: range folding → overlap/fragment merge → harmonic/quiet cleanup → chord alignment → hand assignment and arrangement → chord cap → length smoothing → dynamics. It does not mutate inputs; array metadata carries `splitPoint` and `playabilityDrops`.
- `midi.js`: hand-labelled notes → explicit ticks at 120 BPM. Same-tick same-pitch attacks coalesce, and earlier notes are clipped at later re-strikes so exports have positive lengths and no same-pitch overlaps, even across tracks.

`test/piano.test.mjs` checks the shared pipeline, MIDI round trips, browser option passing, and edge cases. When changing defaults, update module arguments, CLI defaults, and corresponding HTML values together. TensorFlow is overridden to 4.22 in `package.json` because 3.21 had a WebGL concat-shader failure. No server is needed in production.

## Getting the MIDI onto a Meta Quest 3

- **PianoVision:** install the [PianoVision desktop app](https://www.pianovision.com/resources/), run PianoVision on the headset, and link the desktop app to the headset on the same network. Upload the `.mid` and fill in the artist and title. It appears under **Imports** in the headset.
- **Other VR piano apps:** connect the Quest by USB, allow file access on the headset, and copy the `.mid` into the app's folder or **Download**, according to the app's import instructions.
- **Hosted page:** open this page in the Quest browser and download the `.mid` straight to the headset. Use the destination app's supported import method; PianoVision's documented workflow uses its desktop app.
