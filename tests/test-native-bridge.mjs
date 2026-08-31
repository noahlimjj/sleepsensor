// native-bridge.js — Capacitor coordination layer.
// The critical guarantee: on the plain web (no Capacitor) every method is a
// safe no-op so the web app is never affected.
import { section, ok, eq, pass } from './lib.mjs';
import { NativeBridge } from '../js/native-bridge.js';

export async function run() {
  section('native-bridge.js — Capacitor bridge');

  // --- web mode (no globalThis.Capacitor) ---
  {
    const nb = new NativeBridge();
    eq(nb.available, false, 'available=false with no Capacitor runtime');
    eq(nb.platform, 'web', 'platform reported as web');
    eq(nb.supported, false, 'supported=false');

    const prep = await nb.prepare();
    eq(prep.ok, false, 'prepare() ok=false on web');
    ok(Array.isArray(prep.warnings) && prep.warnings.length > 0, 'prepare() warns that recording pauses on lock');

    ok((await nb.beginSession({ title: 't', text: 'x' })) === false, 'beginSession() no-ops to false');
    await nb.updateNotification('hi'); // must not throw
    await nb.endSession(); // must not throw
    eq(await nb.requestIgnoreBatteryOptimizations(), false, 'battery exemption no-ops on web');
    nb.on({ onInterruptionBegan: () => {} }); // must not throw
    await nb.dispose();
    pass('web mode is a clean set of no-ops');
  }

  // --- native mode (mock Capacitor runtime) ---
  {
    const calls = [];
    const listeners = {};
    const mkPlugin = (name) => ({
      start: async (o) => (calls.push([name, 'start', o]), { started: true }),
      stop: async () => calls.push([name, 'stop']),
      update: async (o) => calls.push([name, 'update', o]),
      checkPermissions: async () => ({ microphone: 'granted' }),
      isBatteryOptimizationExempt: async () => ({ exempt: false }),
      requestBatteryOptimizationExemption: async () => ({ exempt: true }),
      getBatteryInfo: async () => ({ batteryLevel: 0.8, isCharging: true }),
      addListener: (ev, fn) => {
        listeners[ev] = fn;
        return { remove() {} };
      },
    });
    globalThis.Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'android',
      registerPlugin: (name) => mkPlugin(name),
    };
    // fresh module instance so it re-reads globalThis.Capacitor
    const { NativeBridge: NB } = await import('../js/native-bridge.js?native=1');
    const nb = new NB();
    eq(nb.available, true, 'available=true under a native runtime');
    eq(nb.platform, 'android', 'platform from getPlatform()');
    ok(nb.supported, 'supported=true when the plugin resolves');

    const prep = await nb.prepare();
    eq(prep.native, true, 'prepare() native=true');
    ok(prep.warnings.some((w) => /battery/i.test(w)), 'prepare() surfaces the battery-optimisation warning');

    ok(await nb.beginSession({ title: 'SleepSensor', text: 'x' }), 'beginSession() calls the plugin');
    ok(calls.some((c) => c[1] === 'start'), 'plugin.start invoked');

    let interrupted = 0;
    nb.on({ onInterruptionBegan: () => interrupted++ });
    listeners.interruptionBegan?.();
    eq(interrupted, 1, 'interruption events forwarded to the callback');

    await nb.updateNotification('2h · 4 snoring');
    ok(calls.some((c) => c[1] === 'update'), 'plugin.update invoked for the notification');

    await nb.endSession();
    ok(calls.some((c) => c[1] === 'stop'), 'plugin.stop invoked');

    delete globalThis.Capacitor;
    pass('native mode drives the plugin correctly');
  }
}
