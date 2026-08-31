# Backend Agent Prompt — SleepSensor

You are building the **backend/engine layer** for SleepSensor, a web-based sleep monitoring app that listens all night and detects snoring and bruxism (teeth grinding) using on-device ML. The frontend agent is handling all UI, design, and visual components separately. Your job is to build the audio pipeline, ML classifier, data persistence, service worker, and device APIs.

**Repo**: https://github.com/noahlimjj/sleepsensor  
**Working directory**: `/Users/User/sleep_app`  
**Deploy target**: Vercel (static site)

---

## Context

This is a vanilla HTML/CSS/JS app (no framework, no bundler). All JS files are ES modules loaded via `<script type="module">`. The app runs in the browser and must work on mobile (phone kept on nightstand, screen can lock but tab stays open). All processing is **on-device** — no server, no cloud uploads, no API calls. Privacy is a core value.

The frontend will import your modules and call them like this:

```js
import { AudioEngine } from './js/audio-engine.js';
import { Classifier } from './js/classifier.js';
import { Storage } from './js/storage.js';
import { WakeLock } from './js/wake-lock.js';
```

---

## Files You Must Create

### 1. `js/audio-worklet-processor.js`

An `AudioWorkletProcessor` that runs in a separate thread. It receives raw PCM audio and performs lightweight analysis.

**Responsibilities:**
- Receive raw PCM audio frames (Float32Array, typically 128 samples per frame at 16kHz)
- Compute RMS energy for each frame
- Accumulate frames into **2-second windows** (32,000 samples at 16kHz)
- When a window is full, compute a **Mel spectrogram** (128 mel bands, 64 time steps) from the window
- Apply a noise gate: if RMS energy of the entire window is below a configurable threshold (default: 0.01), skip classification and send `{ type: 'silence' }`
- Send processed data to the main thread via `this.port.postMessage()`:
  - `{ type: 'energy', rms: number }` — every frame, for live waveform visualization
  - `{ type: 'spectrogram', data: Float32Array, timestamp: number }` — every 2 seconds when above noise gate
  - `{ type: 'silence', timestamp: number }` — every 2 seconds when below noise gate
  - `{ type: 'audio-clip', buffer: Float32Array, startTime: number, endTime: number }` — raw audio for a flagged segment
- Receive messages from main thread:
  - `{ command: 'set-threshold', value: number }` — update noise gate threshold
  - `{ command: 'extract-clip', startTime: number, endTime: number }` — extract audio from a rolling buffer

**Clip extraction**: Maintain a rolling buffer of the last **30 seconds** of raw audio. When the main thread requests a clip (because the classifier detected an event), extract the requested time range and send it back.

**Mel spectrogram computation**: Use the following approach:
- Apply a Hann window to the 2-second audio chunk
- Compute Short-Time Fourier Transform (STFT) with 512-sample FFT, 256-sample hop
- Convert power spectrum to mel scale using 128 mel filter banks
- Apply log scaling: `log(max(mel_power, 1e-10))`
- Normalize to [0, 1] range

Register the processor as `'sleep-audio-processor'`.

---

### 2. `js/audio-engine.js`

The main audio pipeline manager. Exported class: `AudioEngine`.

**Constructor**: `new AudioEngine({ onEnergy, onEvent, onStatusChange })`

**Callbacks the frontend provides:**
- `onEnergy(rms: number)` — called ~60x/sec with current audio energy level (0-1) for waveform viz
- `onEvent(event: { type: 'snoring'|'bruxism', confidence: number, severity: 'mild'|'moderate'|'severe', timestamp: number, duration: number })` — called when a confirmed event is detected
- `onStatusChange(status: 'idle'|'requesting'|'recording'|'error', error?: string)` — called on state changes

**Public API:**
```js
await engine.start()       // Request mic, create AudioContext, connect pipeline, start recording
await engine.stop()        // Stop recording, finalize session, return session summary
engine.getElapsedTime()    // Returns seconds since recording started
engine.setSensitivity(v)   // 0-1 float, adjusts noise gate threshold
engine.isRecording()       // Returns boolean
```

**Internal flow:**
1. `start()`:
   - Request microphone: `navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: 16000, echoCancellation: false, noiseSuppression: false, autoGainControl: false } })`
   - Create `AudioContext` at 16kHz sample rate
   - Load AudioWorklet module from `'./audio-worklet-processor.js'`
   - Connect: `MediaStreamSource → AudioWorkletNode('sleep-audio-processor')`
   - Start the `Classifier`
   - Create a new session in `Storage`
   - Acquire wake lock via `WakeLock`
   - Set status to `'recording'`

2. While recording:
   - Listen for messages from AudioWorklet
   - On `'energy'` messages → forward to `onEnergy` callback
   - On `'spectrogram'` messages → pass to `Classifier.classify(spectrogram)`
   - On classification result → apply debouncing logic:
     - **Debounce rule**: 3 consecutive positive classifications of the same type within 6 seconds = confirmed event
     - Track event start time (first positive) and end time (last positive before gap)
     - When event ends (2+ consecutive negatives), request audio clip from worklet for the event time range (event start - 5 sec → event end + 5 sec)
   - On confirmed event → call `onEvent`, save to `Storage`
   - On audio clip received → save to `Storage` linked to the event

3. `stop()`:
   - Close AudioContext, stop media stream tracks
   - Release wake lock
   - Finalize session in Storage (set end time)
   - Return session summary: `{ sessionId, startTime, endTime, totalDuration, snoringDuration, bruxismDuration, snoringEpisodes, bruxismEpisodes, clips: [...] }`

---

### 3. `js/classifier.js`

ML classification using TensorFlow.js. Exported class: `Classifier`.

**Important**: Since we're building a static site without a bundler, we load TensorFlow.js from CDN. The frontend's `index.html` already includes:
```html
<script src="https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js"></script>
```

So `tf` is available as a global.

**Since we cannot ship a real trained model in a static site**, implement a **heuristic-based classifier** that uses audio feature analysis to detect snoring and bruxism. This is the MVP approach — it can be upgraded to a real ML model later.

**Constructor**: `new Classifier()`

**Public API:**
```js
await classifier.load()                    // Initialize / warm up
classifier.classify(spectrogram: Float32Array) → { type: 'silence'|'snoring'|'bruxism'|'other', confidence: number }
classifier.dispose()                       // Cleanup
```

**Heuristic classification approach:**

Snoring detection:
- Snoring has a characteristic **low-frequency, periodic pattern** (fundamental frequency 30-500 Hz)
- Compute spectral centroid — snoring typically has centroid < 500 Hz
- Check for **rhythmic periodicity** — snoring occurs in regular cycles (inspiration/expiration)
- Check energy concentration in low-frequency mel bands (bands 0-30 out of 128)
- Confidence = weighted combination of these features

Bruxism detection:
- Teeth grinding produces **high-frequency, broadband noise** (1-5 kHz range)
- Compute spectral centroid — bruxism typically has centroid > 1000 Hz
- Check for **sustained, non-periodic** high-frequency energy
- Check energy concentration in high-frequency mel bands (bands 60-128)
- Look for characteristic **spectral flatness** (grinding is noise-like, not tonal)
- Confidence = weighted combination of these features

Classification thresholds:
- If low-freq energy > 0.6 AND periodicity > 0.5 → `snoring` (confidence based on feature strength)
- If high-freq energy > 0.5 AND spectral flatness > 0.6 → `bruxism` (confidence based on feature strength)
- If max energy < 0.1 → `silence`
- Otherwise → `other`

Severity mapping:
- confidence < 0.5 → `'mild'`
- confidence 0.5-0.75 → `'moderate'`
- confidence > 0.75 → `'severe'`

---

### 4. `js/storage.js`

IndexedDB persistence layer. Exported class: `Storage`.

**Database name**: `sleepsensor-db`  
**Version**: 1

**Object stores:**

```
sessions: {
  keyPath: 'id',
  indexes: ['date', 'startTime']
  schema: {
    id: string (uuid),
    date: string (YYYY-MM-DD),
    startTime: number (unix ms),
    endTime: number | null (unix ms),
    totalDuration: number (seconds),
    snoringDuration: number (seconds),
    bruxismDuration: number (seconds),
    snoringEpisodes: number,
    bruxismEpisodes: number,
    snoringPercentage: number (0-100),
    bruxismPercentage: number (0-100)
  }
}

events: {
  keyPath: 'id',
  indexes: ['sessionId', 'type', 'timestamp']
  schema: {
    id: string (uuid),
    sessionId: string,
    type: 'snoring' | 'bruxism',
    startTime: number (unix ms),
    endTime: number (unix ms),
    duration: number (seconds),
    confidence: number (0-1),
    severity: 'mild' | 'moderate' | 'severe',
    hasClip: boolean
  }
}

clips: {
  keyPath: 'id',
  indexes: ['eventId', 'sessionId']
  schema: {
    id: string (uuid),
    eventId: string,
    sessionId: string,
    audioBlob: Blob,
    duration: number (seconds),
    format: 'wav',
    timestamp: number (unix ms)
  }
}

settings: {
  keyPath: 'key',
  schema: {
    key: string,
    value: any
  }
}
```

**Public API:**
```js
const storage = new Storage();
await storage.init();

// Sessions
await storage.createSession(session)           → session
await storage.updateSession(id, updates)       → session
await storage.getSession(id)                   → session | null
await storage.getSessionByDate(dateStr)        → session | null
await storage.getAllSessions()                  → session[]
await storage.getRecentSessions(limit=30)      → session[]
await storage.deleteSession(id)                → void

// Events
await storage.addEvent(event)                  → event
await storage.getEventsBySession(sessionId)    → event[]
await storage.getEventsByType(type, limit=100) → event[]

// Clips
await storage.saveClip(clip)                   → clip
await storage.getClip(id)                      → clip | null
await storage.getClipsBySession(sessionId)     → clip[]
await storage.getClipByEvent(eventId)          → clip | null
await storage.deleteClipsBySession(sessionId)  → void

// Settings
await storage.getSetting(key, defaultValue)    → value
await storage.setSetting(key, value)           → void

// Maintenance
await storage.getStorageUsage()                → { sessions, events, clips, totalBytes }
await storage.pruneOldSessions(keepDays=30)    → number (deleted count)
await storage.exportSession(sessionId)         → { session, events, clips }
await storage.clearAll()                       → void
```

---

### 5. `js/wake-lock.js`

Screen Wake Lock API wrapper. Exported class: `WakeLock`.

**Public API:**
```js
const wakeLock = new WakeLock();
await wakeLock.acquire()    // Request wake lock
await wakeLock.release()    // Release wake lock
wakeLock.isActive()         // Returns boolean
```

**Requirements:**
- Use `navigator.wakeLock.request('screen')` API
- Re-acquire on `document.visibilitychange` event (wake lock is released when tab loses focus)
- Graceful fallback: if Wake Lock API not supported, log warning but don't crash
- Track active/inactive state

---

### 6. `sw.js` (Service Worker)

**Cache name**: `sleepsensor-v1`

**Pre-cache these files on install:**
- `/`, `/index.html`, `/css/index.css`
- `/js/app.js`, `/js/audio-engine.js`, `/js/audio-worklet-processor.js`
- `/js/classifier.js`, `/js/storage.js`, `/js/timeline.js`
- `/js/charts.js`, `/js/wake-lock.js`, `/js/utils.js`
- `/manifest.json`

**Strategy:**
- `install`: Pre-cache all app shell files
- `activate`: Delete old caches
- `fetch`: Cache-first for app shell files, network-first for everything else

---

## Integration Contract

The frontend will interact with your code like this:

```js
// In app.js (frontend)
import { AudioEngine } from './js/audio-engine.js';
import { Classifier } from './js/classifier.js';
import { Storage } from './js/storage.js';
import { WakeLock } from './js/wake-lock.js';

// Initialize
const storage = new Storage();
await storage.init();

const classifier = new Classifier();
await classifier.load();

const engine = new AudioEngine({
  classifier,
  storage,
  onEnergy: (rms) => { /* update waveform viz */ },
  onEvent: (event) => { /* show event toast, update counter */ },
  onStatusChange: (status, error) => { /* update UI state */ }
});

// User taps "Start Recording"
await engine.start();

// User taps "Stop Recording" in the morning
const summary = await engine.stop();

// Load highlights for playback
const clips = await storage.getClipsBySession(summary.sessionId);
// Each clip has .audioBlob (Blob) that can be played with:
// const url = URL.createObjectURL(clip.audioBlob);
// const audio = new Audio(url);
```

---

## Important Notes

1. **No npm, no bundler** — pure ES modules, loaded via `<script type="module">`
2. **TensorFlow.js** is loaded via CDN `<script>` tag (global `tf`), NOT imported as a module
3. **AudioWorklet** file must be a standalone script (not a module), registered via `audioContext.audioWorklet.addModule()`
4. All audio processing must be **privacy-preserving** — no data leaves the device
5. Audio clips stored as WAV Blobs in IndexedDB — include a `float32ToWav()` helper in `audio-engine.js`
6. Generate UUIDs with `crypto.randomUUID()`
7. Target mobile browsers: Chrome Android, Safari iOS — test for API support and provide fallbacks
8. The `audio-worklet-processor.js` file should NOT use `import` statements — it runs in a separate scope
