# MP3 to Piano MIDI

A static browser app and Node CLI for MP3/audio to piano MIDI. Audio stays on your device. The result is an approximate piano arrangement, not a score transcription. Exports use piano instruments, no pitch bends, and an estimated tempo when beat quantization is accepted (otherwise 120 BPM with original timing). The browser and CLI default to a vocal melody with instrumental backing.

## Run

Use Node 24. Install dependencies with `npm ci --cache G:\Temp\npm-cache` on this Windows machine; its default npm cache is broken. The model is already in `public/model`.

```sh
npm run dev
npm test
npx vite build
```

Open the URL printed by Vite, choose audio, press **Convert**, then **Download MIDI**. Serve the page over HTTP rather than opening HTML directly. `dist/` is the static build; `.github/workflows/pages.yml` deploys it to GitHub Pages on pushes to `main`.

Browser vocal separation requires **desktop Chrome or Edge with hardware WebGPU**, on HTTPS or localhost. The adapter must be non-null, not a software/fallback adapter, and support at least 151,000,000 bytes for both `maxStorageBufferBindingSize` and `maxBufferSize`. The Worker requests the adapter's buffer limits. The first two whole chunks predict separation time; a projection above three minutes, device loss, nonfinite output, or another separation error switches to Classic Cover on the already decoded mix and displays the reason. This limit covers separation, not total transcription time.

Without usable WebGPU, the recommended arrangement is disabled and Cover (Classic) is selected. **On Quest: convert on your PC and download the MIDI to the headset.** Classic remains available on the headset; WebGPU separation on Quest is not promised.

First use downloads a 67 MB model from **huggingface.co** (and its download hosts). **Your audio never leaves this browser.** The download is streamed, checked against the SHA-256 below, and stored in Cache Storage `sep-models-v1`; cached bytes are verified before reuse. If storage is full or unavailable, conversion continues with a notice and downloads again next time. The commit-pinned mirror is the browser's model source; if unavailable, Classic Cover is used.

The page decodes 44.1 kHz audio on the main thread and transfers stereo samples to a module Worker. Separation, decimation and vocal melody tracking use the same modules as the CLI. The ONNX session is released and its Worker terminated before Basic Pitch starts on the instrumental. Note extraction runs in a second Worker to keep the page responsive. **Cancel** stops Workers, aborts model downloads and stops Basic Pitch at the next batch boundary, freeing tensors and restoring the form.

`onnxruntime-web` is pinned to **1.30.0** and imported as `onnxruntime-web/webgpu` in the separator Worker. Vite resolves the runtime's own asset URLs: development serves the package assets, and production emits hashed WASM/JavaScript assets under `dist/assets`. There is no copy script, `public/ort`, `wasmPaths` override, or cross-origin isolation requirement. Both module Workers use ES output and the site retains `base: './'` for Pages/subdirectory hosting.

## Controls

The browser exposes arrangement, melody hand/octave, backing, sensitivity, threshold, minimum length and beat snapping. Classic additionally exposes chord size and hand splitting. Other cleanup controls are CLI options.

| Control | What it does | Default |
| --- | --- | --- |
| Arrangement / `--classic --preset` | Vocal melody + backing separates the vocals. The mix-only group offers Full, Easy and Cover (Classic). Easy keeps melody plus the lowest bass; Full keeps transcription chords. | `stems` (Classic fallback: `cover`) |
| Melody hand / `--melody-hand` | Auto uses the existing register rule. Left hand or Right hand forces the melody for the whole song and puts all backing in the opposite hand. | `auto` |
| Melody octave / `--melody-octave` | Shifts the whole melody by −12, 0 or +12 semitones before hand assignment, folding only outside MIDI 36–96. | `0` |
| Backing / `--chords-only` | Chords + pulses, or chords only. Applies to stems arrangements. | Chords + pulses |
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
| `--melody` | Positive enables the melody tracker with rests in Easy/Cover; zero restores highest-note selection. The numeric flag is retained for compatibility. | `3` (on) |

Sensitivity, Note threshold and Min note length control Basic Pitch on the instrumental in stems mode, with the Melodia continuation pass disabled. Max notes per chord and Split hands are hidden there because stems assigns hands explicitly.

Set a cleanup/length option to `0` to disable it. `--no-dynamics` restores raw amplitudes clamped to 0.05–1. The earlier tracker forced a choice in every group; its large-jump floor was a design limitation, not unavoidable transcription noise. Cover remains the Classic default: on five test songs its jump rate is below 13%, time with five sounding notes is below 0.05%, and mean sounding is lower than Full. This is still an estimate from a mix, not vocal isolation.

Each hand is limited to five notes spanning 14 semitones per 30 ms attack group. The boundary may move away from the preferred split; impossible chords lose the quietest offending notes. The sounding cap preserves new attacks and notes younger than 60 ms, so temporary excess polyphony is possible. Sustained notes can still exceed a hand's reach.

A short note is isolated when no same-pitch note starts within 120 ms after its end. Extensions preserve re-strike spacing; multi-note hand attacks skip gap-fill. Beat quantization requires centered onset autocorrelation ≥0.12 and sixteenth-phase concentration ≥0.20; a refined half/double tempo needs ≥1.5 times the phase concentration to replace the original estimate. Unsafe re-strikes revert whole attack groups, preserving chord alignment and attack order. Sounding-cap releases take priority over grid endings/minimums. A common phase shift aligns ticks, not the musical downbeat or meter. `--no-quantize` preserves original timing and 120 BPM.

## Command line

Requires **ffmpeg on PATH** and Node 24:

```sh
node cli.mjs "song.mp3" --out "song.mid" --json
node cli.mjs "song.mp3" --classic --out "song-easy.mid" --preset easy --json
node cli.mjs --help
```

Without `--out`, the MIDI is written beside the input. CPU inference can take several minutes. Model outputs are cached in `.cache/` by basename and size, checked against source path/mtime and model timestamp; parameter changes reuse inference. Delete the matching cache to force inference. Classic decoding is limited to 256 MiB of mono 22050 Hz float audio (about 50 minutes); stems decoding allows 512 MiB of stereo 44100 Hz float audio (about 25 minutes).

### Vocal melody and instrumental backing (browser and CLI default)

The melody comes from the separated vocals; accompaniment comes from the instrumental. By default vocal pitches stay at their real octave, folding only outside MIDI 36–96. Auto phrases use a duration-weighted median: 60 or higher goes right, 57 or lower goes left, and the middle range keeps the previous hand (first phrase: right at 59 or above). Phrases shorter than four seconds share a decision with a neighbouring phrase. Melody rests of at least one second, or two accepted beats, separate phrases. An explicit octave shift applies before this rule; forcing Left or Right overrides only the hand decision.

The other hand plays sparse chord blocks and pulses below or above the melody. Close semitone clashes are revoiced or removed. Vocal gaps of at least two seconds can use an instrumental melody; songs with little detected singing use that fallback throughout. This is a generated arrangement and still needs a listening check.

Extreme hand/octave choices can leave no room for backing within the existing register and span limits. In that case backing notes are omitted while the requested melody is preserved.

```sh
npm i --cache G:\Temp\npm-cache -O onnxruntime-node@1.30.0
node cli.mjs "song.mp3" --keep-stems ".cache/listen/song" --out "song-stems.mid" --json
node cli.mjs "song.mp3" --classic --preset cover --out "song-cover.mid"
node cli.mjs "Kiss of Death.mp3" --melody-hand left --melody-octave -1 --out "Kiss of Death-stems-left-oct-1.mid"
```

The optional Node runtime is loaded only in stems mode. `--ep dml|cpu` chooses separation execution (DirectML on Windows by default, with CPU retry on failure; CPU elsewhere). `--keep-stems <dir>` writes float32 `vocals.wav` and `instrumental.wav`. `--classic` preserves the original Full/Easy/Cover pipeline and does not need ONNX Runtime.

Stems tuning: `--theta 0.65` controls vocal detection, `--split-db 6` controls repeated-note energy dips (`99` disables almost all such splits), `--lh-groove 0.6` controls accompaniment pulses in either hand, `--chords-only` removes pulses, and `--rh-legato 350` sets melody gap filling in milliseconds in either hand. `--no-quantize` preserves timing. Classic preset, hand-split boundary and polyphony controls do not select the stems melody or its hand.

Separation decodes at 44.1 kHz stereo without loudness normalisation. Mono is duplicated; for more than two channels, zero-based even channels are averaged into left and odd channels into right. Both stems use a delay-compensated 31-tap Hann-windowed half-band filter to produce 22.05 kHz mono. Instrumental Basic Pitch extraction skips the Melodia continuation pass. Tempo estimation uses detected attacks, so onset-less continuations cannot move the beat grid; chord estimation still uses all supplied notes. The shared separator uses a periodic Hann; the vocal tracker uses a symmetric Hann.

The model is copied from the local research download when available, otherwise downloaded from the [official UVR release](https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/Kim_Vocal_2.onnx), then checked against SHA-256 `ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b`. It stays in ignored `.cache/models/`. Stem inference caches end in `-stems.json` and retain default melody notes plus instrumental frames; a small vocal audio cache supports melody parameter sweeps. Changes to shared audio-processing code invalidate these caches.

Vocal separation: Kim_Vocal_2 (UVR MDX-Net) by Kimberley Jensen, via Ultimate Vocal Remover. UVR code is MIT; the model weights are not covered by this repository's licence and are downloaded at runtime, not redistributed.

`npm test` uses synthetic fixtures and does not require ONNX Runtime or personal audio. `npm run test:golden` checks optional local Python stem parity, melody counts and the 21 frozen classic MIDI files; missing local fixtures skip cleanly. Pages CI uses `npm ci --omit=optional`, then restores only Vite's two already-locked Linux native bindings with integrity verification.

Local verification reports and listening files are in ignored `.cache/`, including `.cache/STEMS-RUN1.md` and `.cache/STEMS-RUN2.md`.

`--json` writes statistics to stdout and progress to stderr. Statistics describe the final arrangement before MIDI tick rounding. Fragments count same-pitch gaps ≤50 ms, including real repeats; chord/hand metrics use anchored 30 ms groups. Sounding metrics cover first onset through last release. Key estimates use duration-weighted [Krumhansl–Schmuckler profiles](https://music21.org/music21docs/_modules/music21/analysis/discrete.html); out-of-key does not necessarily mean wrong. Wobble counts alternating singleton semitone triples ≤150 ms apart. Melody jump rate counts intervals >7 semitones; Classic follows the highest right-hand pitch per group. `estimatedBpm` is the exported tempo; `gridDeviationMs` measures pre-snap starts against the candidate grid (120 BPM grid after rejection). `tempoConfidence` and `phaseConfidence` report the two guards; `quantizedNotes` counts starts accepted for snapping, and `timingOffsetSeconds` records the common shift. Duration percentiles use ms; velocities use 0–1.

Stems statistics use `role === 'melody'`, including instrumental fallback melody, irrespective of hand. `melodyLeftShare` is a fraction of melody note-time. Classic has no role labels: its melody metrics are explicitly marked `highest-right-hand-estimate` and cannot measure a true vocal melody or its left-hand share. `clashPct` is the union of simultaneous semitone-class clashes within 14 semitones divided by melody note-time. `pctUnder120ms` counts short notes; `perHand` reports accompaniment attacks/s, maximum accompaniment attack groups in any one-second window, mean sounding and maximum sounding. Means use the whole arrangement span, including internal rests.

## How the classic arrangement is built

After cleanup and playable hand assignment, Easy/Cover track right-hand candidates with cost −amplitude/voice maximum + 0.08 per semitone travelled + 0.5 for a gap over one second; skipping a group costs 0.5. The tracker can therefore rest instead of borrowing accompaniment during melody gaps. Cover's bass tracker still chooses from every available group with interval weight 0.04 and lower-pitch ties, then retains at most one accompaniment bass attack per accepted beat (300 ms when no tempo is accepted), choosing the largest amplitude × duration capped at one beat, with earlier attacks winning ties. It tries candidates in that order while avoiding same-pitch-class re-attacks during a bass sustain. Both arrangements preserve original singleton left-hand attacks when the final right-hand melody is silent: these may be the tune crossing the hand split, so they keep their hand labels and bypass bass thinning and Easy's short-note filter. Turning off grid snapping preserves this selection. At retained bass attacks, changed left-hand pitch-class sets may add at most two in-key tones from the strongest 40% of original groups. The sounding cap runs before and after guarded quantization.

- `extract.js`: model frames/onsets → timed notes; subtracts one frame from Basic Pitch's exclusive minimum-length cutoff and labels onset-less continuations with zero onset.
- `piano.js`: shared cleanup, voice tracking, tempo estimation, quantization, and dynamics. Removed anchors trigger regrouping. Inputs are unchanged; array metadata carries hand, tempo, and timing diagnostics.
- `midi.js`: hand-labelled notes → explicit ticks at the estimated tempo. Same-tick same-pitch attacks coalesce; cross-hand re-strikes leave a one-tick release gap. Adjacent-tick handoffs coalesce when a positive note and release gap cannot both fit.

`pianoDefaults` and `defaultMaxSounding(preset)` in `piano.js`, plus `stemsDefaults` in `stems.js`, are the shared defaults. Browser/CLI parity tests cover all stems options with a fake separation result; synthetic Worker tests cover progress, completion, error, cancellation, GPU gating and model caching. `main.js` decodes browser audio and scopes/disposes the Basic Pitch model per conversion, with WebGL-to-CPU fallback; `cli.mjs` handles ffmpeg, local inference caching, and statistics. Tests also cover MIDI round trips and a quantized browser download. TensorFlow is overridden to 4.22 because 3.21 had a WebGL concat-shader failure. No server is needed in production.

## Getting the MIDI onto a Meta Quest 3

- **PianoVision:** install the [PianoVision desktop app](https://www.pianovision.com/resources/), run PianoVision on the headset, and link the desktop app to the headset on the same network. Upload the `.mid` and fill in the artist and title. It appears under **Imports** in the headset.
- **Other VR piano apps:** connect the Quest by USB, allow file access on the headset, and copy the `.mid` into the app's folder or **Download**, according to the app's import instructions.
- **Hosted page:** Classic can convert directly on the Quest browser. For vocal separation, convert on a desktop PC, then transfer/download the resulting MIDI to the headset. Use the destination app's supported import method; PianoVision's documented workflow uses its desktop app.
