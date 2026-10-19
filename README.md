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
- **Min note length (ms):** filters short detections (default 60 ms).
- **Max simultaneous notes:** keeps the loudest notes in each group starting within 30 ms (default 6). Sustained notes from earlier groups can still overlap.
- **Split hands at middle C:** two piano tracks, left below MIDI 60 and right at MIDI 60 or above. Uncheck for one piano track.

Choose a file, press **Convert**, then **Download MIDI**. The download keeps the original filename with a `.mid` extension.

## Getting the MIDI onto a Meta Quest 3

- **PianoVision:** install the [PianoVision desktop app](https://www.pianovision.com/resources/), run PianoVision on the headset, and link the desktop app to the headset on the same network. Upload the `.mid` and fill in the artist and title. It appears under **Imports** in the headset.
- **Other VR piano apps:** connect the Quest by USB, allow file access on the headset, and copy the `.mid` into the app's folder or **Download**, according to the app's import instructions.
- **Hosted page:** open this page in the Quest browser and download the `.mid` straight to the headset. Use the destination app's supported import method; PianoVision's documented workflow uses its desktop app.
