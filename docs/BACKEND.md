# SleepSensor — backend / engine layer

Everything runs **on the device**. No audio, metrics, or clips ever leave the
browser. There is no server.

## Modules

| File | Export | Role |
| --- | --- | --- |
| `js/audio-worklet-processor.js` | *(classic script)* | Audio-thread DSP. Resamples the native rate to a fixed **16 kHz**, computes RMS / peak / zero-crossing rate, accumulates 2‑second windows, builds a 128×64 log‑mel spectrogram, applies a noise gate, and keeps a 30‑second rolling raw‑audio buffer for clip extraction. Registered as `sleep-audio-processor`. |
| `js/features.js` | `extractFeatures`, `FEATURE_NAMES` | Turns one spectrogram (+ rms/peak/zcr hints) into a 14‑value feature vector: low/mid/high band ratios, spectral centroid/spread/rolloff/flatness/crest, a harmonic‑comb score, envelope periodicity & modulation depth, spectral flux, zcr, loudness. Shared by the classifier and the offline trainer. |
| `js/model-weights.js` | `MODEL` | **Auto‑generated** by `training/train.mjs`. A tiny MLP (14 → 24 → 4) — ~5 KB of weights + standardisation stats + validation metrics. |
| `js/classifier.js` | `Classifier` | Runs the MLP (`quiet / snoring / bruxism / noise`) with a plain hand‑tuned heuristic as fallback if the weights are missing. `classify(spec, {rms,peak,zcr})` → `{ type, confidence, scores, db }`. Hard RMS floor for silence. |
| `js/audio-engine.js` | `AudioEngine`, `float32ToWav`, `sensitivityToThreshold` | Mic → worklet → classifier → storage pipeline. Robust mic acquisition, event debounce, generic **loud‑noise** events, **loudest‑moment highlights**, live **dB** metering, background‑resilience watchdog, session summary. |
| `js/storage.js` | `Storage` | IndexedDB **v2**: `sessions`, `events`, `clips` (`clipType: 'event'|'highlight'`), `highlights`, `settings`. Cascade delete, pruning, export, usage. |
| `js/wake-lock.js` | `WakeLock` | Screen Wake Lock wrapper, auto re‑acquire on visibility change, silent fallback. |
| `sw.js` | *(service worker)* | Offline app shell (owned jointly with the frontend). |

## Pipeline

```
getUserMedia (mono, ideal 16 kHz, no AGC/NS/AEC — requested FIRST, in the tap)
  └─ MediaStreamSource ─→ AudioWorkletNode ─→ Gain(0) ─→ destination
        + silent looping BufferSource (keep-alive)
  worklet →  energy       {rms, peak}          ~62 Hz  → onEnergy(rms, dBFS)
  worklet →  spectrogram  {data, rms, peak, zcr, timestamp}  every 2 s → classify()
  worklet →  silence      {rms, peak, timestamp}            every 2 s
  worklet ←  set-threshold | extract-clip
  worklet →  audio-clip   {buffer}  → float32ToWav (16 kHz) → Storage
```

### Events

Three types: `snoring`, `bruxism`, `noise`.

- Classifier says snoring/bruxism (confidence ≥ 0.35) → that type.
- Otherwise, if the window is above the ambient floor (`rms ≥ ~0.012`, ≈ soft
  speech) → generic `noise` (coughing, talking, a door, a baby, traffic…).
- **3** consecutive positive windows of the same type within 6 s → confirmed
  event (`onEvent`, stored). **2** consecutive negatives end it → a WAV clip of
  `start‑5 s … end+5 s` is pulled from the rolling buffer and stored.
- Each event carries `peakDb` (dBFS).

### Loudest‑moment highlights

Independent of classification. The engine keeps the **top 12** windows of the
night by peak amplitude; each gets an ~8 s WAV clip and a `highlights` row
(`peak`, `db`, `classifiedAs`). Repeats of the same bout (<25 s apart) collapse;
quieter highlights are evicted (clip deleted) when a louder one arrives.

### Live level / dB

- `onEnergy(rms, dbFS)` fires ~62×/s.
- `engine.getLevel()` → `{ rms, peak, dbFS, peakDbFS, spl }` — `spl` is a rough,
  clearly‑labelled room‑loudness estimate (uncalibrated, ±10 dB).
- `engine.describeSensitivity(v)` → `{ label, detail, thresholdDbFS }` for the
  settings slider (Low / Medium / High / Maximum + one plain sentence).

### Background / screen‑off

Honest limitation: **web browsers pause audio when the screen locks** (hard rule
on iOS, common on Android). Mitigations in place: screen wake lock (+ auto
re‑acquire), a silent keep‑alive source, an `AudioContext` `statechange` +
`visibilitychange` handler that resumes and reports recovered gaps, and a stall
watchdog. `engine.backgroundGuidance()` returns device‑specific advice.
Reliable all‑night, screen‑off capture needs the Capacitor wrapper.

### `engine.stop()` summary

```js
{ sessionId, startTime, endTime, totalDuration,
  snoringDuration, bruxismDuration, noiseDuration,
  snoringEpisodes, bruxismEpisodes, noiseEpisodes,
  snoringPercentage, bruxismPercentage,
  loudestDb,
  clips:      [ { id, eventId, clipType, audioBlob, duration, ... } ],
  highlights: [ { id, timestamp, peak, db, classifiedAs, hasClip, ... } ] }
```

## The model

Trained offline on:

- **Kaggle "Snoring" dataset** (Tareq Khan) — 500 snore / 500 non‑snore 1 s clips,
  via the `adrianagaler/Snoring-Detection` mirror.
- ~18 YouTube recordings of teeth grinding (bruxism).
- Ambient / speech / rain / fan / TV clips for `noise` and `quiet`.

≈ 5 500 two‑second windows → 14 features → MLP. **Validation accuracy ≈ 92 %**;
held‑out **snoring↔bruxism confusion < 1 %** (the problem it exists to solve).
Feature design follows the snoring‑detection literature (sub‑band energy around
500 Hz / 1 kHz, spectral centroid & flatness, harmonic‑product‑style pitch,
spectral flux).

Retrain:

```bash
bash training/fetch-data.sh      # download corpus (needs yt-dlp + ffmpeg)
git clone --depth 1 https://github.com/adrianagaler/Snoring-Detection training/_snoredet
npm run train:data               # -> training/features.json
npm run train                    # -> js/model-weights.js  (+ prints confusion matrix)
npm test                         # model-weights test replays a holdout
```

## Tests

```bash
npm test              # 149 assertions: DSP, features, model holdout, classifier
                      #   (real clips), storage v2, WAV, engine debounce/noise/
                      #   highlights/dB/sensitivity
npm run test:browser  # end-to-end in Chromium — real pipeline fed a real snoring
                      #   WAV through a shimmed mic, + SW / app-shell smoke test
```
