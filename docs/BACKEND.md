# SleepSensor — backend / engine layer

Everything here runs **on the device**. No audio, no metrics, and no clips ever
leave the browser. There is no server component.

## Modules

| File | Export | Role |
| --- | --- | --- |
| `js/audio-worklet-processor.js` | *(classic script)* | Runs on the audio thread. RMS energy per frame, 2‑second windowing, log‑mel spectrogram, noise gate, 30‑second rolling raw‑audio buffer for clip extraction. Registered as `sleep-audio-processor`. |
| `js/audio-engine.js` | `AudioEngine`, `float32ToWav`, `sensitivityToThreshold` | Owns the mic → worklet → classifier → storage pipeline for one night. Debounces classifications into confirmed events, extracts and stores WAV clips, produces the session summary. |
| `js/classifier.js` | `Classifier` | Transparent heuristic classifier (spectral centroid, low/high band ratios, spectral flatness, envelope periodicity). Returns `{ type, confidence }` for `silence \| snoring \| bruxism \| other`. Warms up TensorFlow.js if present so a real model can be dropped in later. |
| `js/storage.js` | `Storage` | IndexedDB (`sleepsensor-db` v1): `sessions`, `events`, `clips`, `settings`. Cascade delete, pruning, export, usage stats. |
| `js/wake-lock.js` | `WakeLock` | Screen Wake Lock wrapper with auto re‑acquire on `visibilitychange` and a silent no‑op fallback. |
| `sw.js` | *(service worker)* | `sleepsensor-v1` cache. Cache‑first app shell, stale‑while‑revalidate for the TF.js CDN bundle, network‑first for the rest. Fully offline capable. |

## Pipeline

```
getUserMedia (mono, 16 kHz, no AGC/NS/AEC)
  └─ MediaStreamSource ─→ AudioWorkletNode('sleep-audio-processor') ─→ GainNode(0) ─→ destination
        worklet →  { type:'energy', rms }            ~62 Hz   → onEnergy()
        worklet →  { type:'spectrogram', data, rms } every 2 s → Classifier.classify()
        worklet →  { type:'silence', rms }           every 2 s → negative for debounce
        worklet ←  { command:'set-threshold' | 'extract-clip' }
        worklet →  { type:'audio-clip', buffer }              → float32ToWav() → Storage.saveClip()
```

### Event debounce

- **3** consecutive positive classifications of the same type within **6 s** → confirmed event (`onEvent`, written to `events`).
- **2** consecutive negatives (silence / other) → event ends. The engine then asks the worklet for `event start − 5 s … event end + 5 s` of raw audio and stores it as a WAV clip linked to the event.
- Switching positive type finalises the current event and starts a new one.
- Positives below `Classifier.minConfidence` (0.35) are ignored.

### Session summary (returned by `engine.stop()`)

```js
{ sessionId, startTime, endTime, totalDuration,
  snoringDuration, bruxismDuration,
  snoringEpisodes, bruxismEpisodes,
  snoringPercentage, bruxismPercentage,
  clips: [ { id, eventId, audioBlob, duration, format, timestamp } ] }
```

## Tests

```bash
npm test              # unit suites: DSP, classifier, storage, WAV, debounce (Node + fake-indexeddb)
npm run test:browser  # end-to-end in Chromium with a fake mic fed synthetic snoring + SW/app-shell smoke test
```

The browser test needs Playwright's Chromium (`npx playwright install chromium`).

## Notes / limitations

- The classifier is an **honest heuristic**, not a trained model. Grinding
  detection in particular is approximate; every event carries a confidence and
  the UI lets the user flag mistakes. Swap `Classifier` for a TF.js model behind
  the same `classify()` signature when labelled data exists.
- Pure PWA background audio is unreliable on mobile — the phone must stay on the
  charger with the tab open. A Capacitor wrapper is the path to true background
  recording later.
- `AudioContext` may not honour a 16 kHz request on some browsers; the worklet
  reads the real `sampleRate` at runtime and adapts.
