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
- **Min note length (ms):** filters short detections (default 80 ms).
- **Max simultaneous notes:** keeps the loudest notes in each group starting within 30 ms (default 6). Sustained notes from earlier groups can still overlap.
- **Split hands at middle C:** two piano tracks, left below MIDI 60 and right at MIDI 60 or above. Uncheck for one piano track.

Weak-onset fragments of the same pitch are joined across gaps of up to 80 ms before chord limiting. Starts with an onset strength of 0.65 or greater stay separate, preserving stronger repeated notes; overlapping notes still merge as before. This reduces false re-attacks in full mixes, though transcription remains approximate.

Choose a file, press **Convert**, then **Download MIDI**. The download keeps the original filename with a `.mid` extension.

## Command line

Use Node 24 with **ffmpeg on PATH** and the project's dependencies installed:

```sh
node cli.mjs "song.mp3" --out "song.mid" --json
```

The CLI uses the same extraction, smoothing, and MIDI code as the browser. It decodes to mono 22050 Hz, loads `public/model` locally, and runs inference on the CPU. The first run can take several minutes; model outputs are saved in `.cache/` so changing parameters skips inference. Cache entries are checked against the source path, size, modification time, and model timestamp. Delete the corresponding cache file to force inference again.

Options: `--onset`, `--frame`, `--min` (milliseconds), `--poly`, `--tolerance` (model frames), `--legato` (weak-onset threshold; `0` disables fragment smoothing), and `--no-split`. Run `node cli.mjs --help` for defaults. Without `--out`, MIDI is written beside the input with a `.mid` extension.

Browser and CLI defaults are onset `0.5`, frame `0.3`, minimum `80` ms, polyphony `6`, energy tolerance `11` frames, legato `0.65`, and split hands enabled. For the previous behaviour, use `--min 60 --legato 0`.

Statistics include note count, last note end in seconds, notes/second, median duration, percentage under 100 ms, same-pitch pairs separated by at most 50 ms, their later notes' mean onset strength, and peak sounding notes. Strong repeated notes also count in the fragment statistic. `--json` prints one JSON object to stdout; progress goes to stderr.

## Getting the MIDI onto a Meta Quest 3

- **PianoVision:** install the [PianoVision desktop app](https://www.pianovision.com/resources/), run PianoVision on the headset, and link the desktop app to the headset on the same network. Upload the `.mid` and fill in the artist and title. It appears under **Imports** in the headset.
- **Other VR piano apps:** connect the Quest by USB, allow file access on the headset, and copy the `.mid` into the app's folder or **Download**, according to the app's import instructions.
- **Hosted page:** open this page in the Quest browser and download the `.mid` straight to the headset. Use the destination app's supported import method; PianoVision's documented workflow uses its desktop app.
