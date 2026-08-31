# SleepSensor 🛌

AI-powered sleep monitor that detects snoring and teeth grinding (bruxism), tracks your sleep quality, and replays audio highlights — all processed on-device for complete privacy.

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

## License

MIT
