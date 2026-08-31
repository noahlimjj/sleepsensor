// SleepSensor BackgroundRecorder — JS proxy.
// The app talks to this plugin through js/native-bridge.js via
// Capacitor.registerPlugin('BackgroundRecorder'); this module exists so the
// package resolves as a Capacitor plugin during `npx cap sync`.
import { registerPlugin } from '@capacitor/core';

export const BackgroundRecorder = registerPlugin('BackgroundRecorder');
