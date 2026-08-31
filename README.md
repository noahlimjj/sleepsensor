# SleepSensor 🛌

AI-powered sleep monitor that detects snoring and teeth grinding (bruxism), tracks your sleep quality, and replays audio highlights — all processed on-device for complete privacy.

## Install the app

For all-night recording with the screen locked, install the native iOS / Android
build: <https://sleepsensor.vercel.app/install>. Full step-by-step (SideStore,
APK sideload, paid options, troubleshooting) is in [`docs/SIDELOAD.md`](docs/SIDELOAD.md);
the architecture is in [`docs/CAPACITOR.md`](docs/CAPACITOR.md).

The browser PWA still works everywhere, but pauses audio when the screen turns
off (a hard browser limit, absolute on iOS).

## Features

- 🎤 **All-night monitoring** — listens via your phone's microphone
- 🧠 **On-device ML** — snoring & bruxism detection using audio analysis (no cloud)
- 📊 **Morning reports** — sleep timeline, severity breakdown, duration stats
- 🔊 **Replay highlights** — listen to flagged audio clips
- 📈 **History & trends** — track patterns over weeks and months
- 🔒 **Privacy-first** — all audio stays on your device, never uploaded
- 📱 **PWA** — installable on your phone's home screen

## Tech Stack

- Vanilla HTML / CSS / JavaScript (no frameworks)
- Web Audio API + AudioWorklet for real-time processing
- TensorFlow.js for on-device ML inference
- IndexedDB for local data persistence
- Canvas-based charts and timeline visualization
- Progressive Web App (PWA)

## Getting Started

```bash
# Serve locally
npx -y serve .

# Or use any static file server
python3 -m http.server 8000
```

Then open `http://localhost:3000` (or 8000) on your phone.

The installable iOS / Android apps are built by `.github/workflows/build.yml`
(APK + unsigned IPA on every push to `main`; both attached to a GitHub Release on
`v*` tags). To build them locally: `npm install && bash scripts/setup-capacitor.sh`.

## License

MIT
