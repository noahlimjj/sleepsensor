# SleepSensor — backend / engine layer

Everything runs **on the device**. No audio, metrics, or clips ever leave the
browser. There is no server.

## Modules

| File | Export | Role |
| --- | --- | --- |
| `js/audio-worklet-processor.js` | *(classic script)* | Audio-thread DSP. Resamples the native rate to a fixed **16 kHz**, computes RMS / peak / zero-crossing rate, accumulates 2‑second windows, builds a 128×64 log‑mel spectrogram, applies a noise gate, and keeps a 30‑second rolling raw‑audio buffer for clip extraction. Registered as `sleep-audio-processor`. |
| `js/features.js` | `extractFeatures`, `FEATURE_NAMES` | Turns one spectrogram (+ rms/peak/zcr hints) into a **46**‑value feature vector: 14 hand‑designed descriptors (band ratios, centroid/spread/rolloff/flatness/crest, harmonic‑comb pitch, envelope periodicity & modulation, spectral flux, zcr, loudness) + 13 MFCC means + 6 MFCC temporal deltas + 6 MFCC temporal std + 7 spectral‑contrast bands. Shared by the classifier and the offline trainer. |
| `js/model-weights.js` | `MODEL` | **Auto‑generated** by `training/train.mjs`. A small MLP (46 → 96 → 48 → 4) as plain weight arrays + standardisation stats + a recording‑independent test confusion matrix. Pure‑JS inference (variable‑depth dense net). |
| `js/classifier.js` | `Classifier` | Runs the MLP (`quiet / snoring / bruxism / noise`) with a hand‑tuned heuristic fallback. `classify(spec, {rms,peak,zcr})` → `{ type, confidence, scores, db }`. `scores` is the raw per‑class distribution — feed it to the smoother. Hard RMS floor for silence. |
| `js/smoothing.js` | `HmmSmoother` | Online HMM forward filter over the per‑window `scores`. Emissions = model probs, transition matrix favours staying in the same state. Turns noisy ~93 % per‑window output into stable event‑level decisions. `push(scores)` → `{ type, confidence, probs }`. AudioEngine owns one per session. |
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
- ~70 YouTube snoring recordings + 40 ESC‑50 snoring clips.
- ~35 YouTube recordings of teeth grinding (bruxism) — the scarce class.
- Ambient / speech / rain / fan / traffic / TV / pets clips for `noise`, plus
  synthetic "hard negatives": steady grinding‑band noise labelled `noise` so the
  model learns that real grinding needs rhythmic jaw modulation.
- **Physically‑modelled synthetic** snoring and bruxism (`training/synth.mjs`) —
  a minority of each class, heavily randomised. Bruxism data is so scarce that
  this is what lifts grinding recall from ~33 % to ~76 %.

≈ 16 000 two‑second windows → 46 features → MLP (46→96→48→4), with 2× waveform
augmentation, label smoothing, and a **recording‑independent** train/val/test
split (no window leakage — the honest metric).

**Speaker/recording‑independent test:** per‑window ≈ 81 %, **per‑episode
(HMM‑smoothed, as shipped) ≈ 89 %.** Snoring ≈ 97 % episode recall; bruxism
≈ 80 % episode recall (held to a higher confidence bar in the engine because its
precision is lower). 99 % on grinding specifically is not achievable without a
labelled sleep‑lab bruxism dataset (none is public).

The earlier "92 %" was measured with window‑level leakage (windows from one
recording in both train and test) and did not reflect real performance.

Retrain:

```bash
bash training/fetch-data.sh      # base corpus (needs yt-dlp + ffmpeg)
bash training/fetch-more.sh      # more snoring/grinding/noise + ESC-50
git clone --depth 1 https://github.com/adrianagaler/Snoring-Detection training/_snoredet
npm run train:data               # -> training/features.json  (--aug 2 for augmentation)
npm run train                    # -> js/model-weights.js  (+ confusion matrices)
npm test                         # replays a holdout through the shipped inference code
```

`training/train-cnn.mjs` is an experimental spectrogram‑CNN path (exports a TF.js
LayersModel to `js/model-cnn/`, which `classifier.js` auto‑detects and prefers).
It did not beat the feature MLP on this dataset — the bottleneck is bruxism data,
not model capacity — so no CNN is shipped.

## Tests

```bash
npm test              # 149 assertions: DSP, features, model holdout, classifier
                      #   (real clips), storage v2, WAV, engine debounce/noise/
                      #   highlights/dB/sensitivity
npm run test:browser  # end-to-end in Chromium — real pipeline fed a real snoring
                      #   WAV through a shimmed mic, + SW / app-shell smoke test
```
