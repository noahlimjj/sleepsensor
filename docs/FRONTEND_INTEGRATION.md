# Backend → Frontend integration notes

Changes the engine/backend just shipped that the UI should surface. Contract is
backward compatible — nothing breaks if you ignore these — but several user
requests need UI work only you can do.

## 1. Microphone "permission denied" was often false

`engine.start()` now requests the mic *first* (before any `await`) and maps
failures to clear messages. `onStatusChange(status, message, extra)` now gets:

| status | when | UI |
| --- | --- | --- |
| `requesting` | asking for the mic | "Requesting microphone…" |
| `recording` | running | normal |
| `error` | could not start | **show `message` verbatim** — it's now actionable (e.g. how to re‑enable mic in site settings). `extra.name` is the DOMException name. |
| `interrupted` | OS paused audio (screen lock) | banner: "Paused by the phone — keep the app open" |
| `stalled` | no audio ≥ 9 s | same banner |
| `recording` again | recovered | `extra.recoveredGapSec` = seconds missed |

Also: `await engine.backgroundGuidance()` → `{ canRunScreenOff:false, text }`.
Show `text` on the record screen or in settings. **Be honest:** browsers pause
audio when the screen locks; tell users to keep the screen on + phone charging.

## 2. Live dB meter (user asked for this explicitly)

- `onEnergy(rms, dbFS)` — second arg is new (decibels full scale, ~‑60 quiet, 0 loud).
- `engine.getLevel()` → `{ rms, peak, dbFS, peakDbFS, spl }`. Poll it in your
  waveform rAF loop. `spl` is a friendly ~room‑loudness number (e.g. "42 dB") —
  label it "approx".
- Suggested: show current dB near the waveform, e.g. `-32 dBFS · ~55 dB`.

## 3. Sensitivity slider is confusing (user asked)

`engine.describeSensitivity(v)` → `{ value, label, detail, thresholdDbFS }`
where `label` ∈ Low / Medium / High / Maximum and `detail` is one sentence.
Suggested UI: label the ends **"Less sensitive"** ↔ **"More sensitive"**, and
under the slider show `label` + `detail` live as it moves. Higher = picks up
quieter sounds. Slider value 0‑100 → pass `v/100` to `engine.setSensitivity`.

## 4. New event type: `noise`

`onEvent({ type })` can now be `'snoring' | 'bruxism' | 'noise'`. `noise` =
any loud/other sound (talking, cough, door, baby, traffic). Needs:
- a third live counter on the record screen (or fold into one "events" count)
- an icon/label + color for `noise` in the toast, timeline, severity list, clips
- events also carry `peakDb` (number, dBFS) — nice to show on each event/clip row

`storage.getEventsByType('noise')` works. Timeline legend needs a 3rd colour.

## 5. Loudest‑moment highlights (user asked: "record loudest clips, let me replay")

Separate from events. After `stop()`, `summary.highlights` is an array (loudest
first) and `summary.loudestDb` is a number. Per highlight:

```js
{ id, sessionId, timestamp, peak, db, rms, classifiedAs, confidence, hasClip }
```

`classifiedAs` is `'snoring' | 'bruxism' | 'noise' | 'unknown'` — **`unknown`
means it was loud enough to keep but the model wasn't sure what it was.** Show
these too (label them "Unknown sound" or similar). A window qualifies as a
highlight on a loud instantaneous **peak** (≈ -26 dBFS) OR a loud sustained
level, so brief bangs/shouts are caught even in an otherwise quiet minute.
`summary.loudestDb` is always the true loudest instant of the night.

APIs: `storage.getHighlightsBySession(id)`, and the clips:
`storage.getClipsBySessionType(sessionId, 'highlight')` →
`{ id, eventId /* = highlight id */, clipType:'highlight', audioBlob, duration }`.
Match `clip.eventId === highlight.id`.

Suggested: a "Loudest moments" carousel on the Morning Report, each item shows
`db` (e.g. "‑6 dB"), `classifiedAs`, time, and a play button
(`URL.createObjectURL(clip.audioBlob)`). Event clips are still
`storage.getClipsBySessionType(sessionId, 'event')`.

## 6. Storage is now v2

New `highlights` object store + `clipType` on clips. The migration is automatic
(`onupgradeneeded`). `getStorageUsage()` now also returns `.highlights`.
`exportSession()` now also returns `.highlights`.

## 7. Session summary — new fields

```
noiseDuration, noiseEpisodes, loudestDb, highlights[]
```
plus the existing snoring/bruxism ones.

## 8. sw.js

Added `/js/features.js` and `/js/model-weights.js` to `APP_SHELL` (needed by the
classifier — keep them in the precache list when you edit sw.js).

## 9. Known frontend bug seen in testing

`roundRect()` in a canvas renderer was called with a negative radius
(`Radius value -16 is negative`) on the report/history screen — throws and
aborts that render. Clamp the radius to `>= 0` (likely `charts.js` or
`timeline.js` when a value/height goes negative).

## 10. Accuracy (for honest UI copy)

Speaker/recording-independent test: **per-window ~81%, per-episode ~89%**
(snoring ~97% episode recall, bruxism ~80%). Don't claim "99%" or "clinical".
Fair copy: "detects snoring and teeth grinding on-device" / "flags likely
grinding — review the clips". Every event already carries a confidence the UI
can show. Bruxism is deliberately conservative (higher confidence bar) so it
under-reports rather than false-alarms.
