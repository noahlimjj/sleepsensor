/*
 * firebase-config.js — SleepSensor
 *
 * Paste your Firebase *web app* config here (Firebase console → Project
 * settings → Your apps → SDK setup and configuration → "Config").
 *
 * Until you do, every value stays a placeholder and the app runs exactly as it
 * does today — 100 % on‑device, no accounts, no sync. Nothing breaks.
 *
 * See docs/FIREBASE.md for the full setup (Auth providers, Firestore, rules).
 */

export const FIREBASE_CONFIG = {
  apiKey: '',
  authDomain: '',
  projectId: '',
  storageBucket: '',
  messagingSenderId: '',
  appId: '',
};

// pinned SDK version loaded from Google's CDN (no bundler needed)
export const FIREBASE_SDK_VERSION = '10.13.0';

// which sign-in methods to offer in the UI (must also be enabled in the console)
export const AUTH_METHODS = {
  guest: true, // anonymous — one tap, upgradeable later
  email: true,
  google: true,
  apple: false, // needs an Apple Developer account — see docs/FIREBASE.md §6
};

/** True once real values have been filled in. */
export function firebaseConfigured() {
  const c = FIREBASE_CONFIG;
  return (
    !!c.apiKey &&
    !c.apiKey.startsWith('YOUR_') &&
    !!c.projectId &&
    !c.projectId.startsWith('YOUR_') &&
    !!c.appId &&
    !c.appId.startsWith('YOUR_')
  );
}
