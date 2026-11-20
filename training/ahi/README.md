# Acoustic AHI validation

Tooling behind the breathing-pause detector in `js/apnea-detector.js`.

**Reference data:** PSG-Audio (Korompili et al., Scientific Data 2021, Science Data Bank
doi:10.11922/sciencedb.00345): full hospital sleep studies with a room microphone about
1 m above the bed, apneas and hypopneas scored by sleep technicians. Nothing from the
dataset is committed; files live in `~/datasets/psg-audio` (override with `PSG_AUDIO_DIR`).

**What was used:** 20 one-hour segments from 18 patients (night AHI 3.7 to 82), 428 scored events.
The host allows about two connections at ~0.5 MB/s, so whole nights were not practical.

| step | command |
| --- | --- |
| download hours, keep the room mic as 16 kHz FLAC | `PAR=2 SEGS='002' bash fetch-patient.sh <id>...` |
| annotations (`rml/<id>.rml`) | URLs are in `allurl.txt` (fetched by the script), `/V3/APNEA_RML/` |
| band envelopes incl. the app's own breathing meter | `node bands.mjs <id>` |
| streaming detector == offline reference | `node check-stream.mjs` |
| fit shipped weights + cut-off | `node fit-final.mjs` |
| held-out accuracy (leave one patient out) | `node lopo.mjs` |
| end-to-end through `ApneaDetector` | `node validate.mjs` |

**Results (events per hour vs the sleep study, per one-hour segment)**

| | correlation | mean abs error | ≥15/h caught | <15/h kept below |
| --- | --- | --- | --- | --- |
| previous snore → silence → snort rule | n/a | found 0 of 428 events | 0 of 8 | 12 of 12 |
| new detector, leave-one-patient-out | 0.84 | 10.0 /h | 8 of 8 | 8 of 12 |
| new detector, shipped weights (in-sample) | 0.88 | 8.8 /h | | |

**Limits, stated plainly**

- Hospital room microphone, not a phone on a nightstand; no phone-recorded night with a
  reference study has been tested yet.
- 20 hours is a small sample and 85% of the dataset's patients are severe, so the mild
  and healthy range rests on 12 hours from 9 patients.
- Per-hour error of about 10 events is too coarse to tell 3/h from 12/h. Healthy,
  restless sleepers can read 10–30/h. Treat the number as a screening hint.
- Single events line up with scored events only about half the time (precision and recall
  both 0.54 with the shipped weights); the hourly rate is the validated quantity.
