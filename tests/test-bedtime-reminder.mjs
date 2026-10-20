// bedtime-reminder.js — daily "start SleepSensor?" local notification.
// On the plain web it must be a no-op; under a native runtime it schedules a
// daily repeating notification with Start / Not tonight actions.
import { section, ok, eq, pass } from './lib.mjs';
import { BedtimeReminder, parseTime } from '../js/bedtime-reminder.js';

export async function run() {
  section('bedtime-reminder.js — bedtime notification');

  // --- time parsing ---
  {
    const t = parseTime('23:00');
    ok(t && t.hour === 23 && t.minute === 0, 'parses 23:00');
    const t2 = parseTime('7:05');
    ok(t2 && t2.hour === 7 && t2.minute === 5, 'parses single-digit hour');
    eq(parseTime('24:00'), null, 'rejects hour 24');
    eq(parseTime('12:60'), null, 'rejects minute 60');
    eq(parseTime(''), null, 'rejects empty');
    pass('parseTime handles <input type="time"> values');
  }

  // --- web mode ---
  {
    const br = new BedtimeReminder();
    eq(br.supported, false, 'supported=false with no Capacitor runtime');
    const res = await br.enable({ hour: 23, minute: 0 });
    eq(res.ok, false, 'enable() no-ops on web');
    eq(res.reason, 'unsupported', 'enable() reports unsupported');
    await br.disable(); // must not throw
    br.onAction(() => {}); // must not throw
    eq(await br.ensurePermission(), false, 'ensurePermission() false on web');
    pass('web mode is a clean set of no-ops');
  }

  // --- native mode (mock Capacitor runtime) ---
  {
    const calls = [];
    const listeners = {};
    let perm = 'prompt';
    let grantOnRequest = true;
    const ln = {
      checkPermissions: async () => ({ display: perm }),
      requestPermissions: async () => {
        calls.push(['requestPermissions']);
        if (grantOnRequest) perm = 'granted';
        return { display: perm };
      },
      registerActionTypes: async (o) => calls.push(['registerActionTypes', o]),
      schedule: async (o) => calls.push(['schedule', o]),
      cancel: async (o) => calls.push(['cancel', o]),
      addListener: (ev, fn) => {
        listeners[ev] = fn;
        return { remove() {} };
      },
    };
    globalThis.Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
      registerPlugin: (name) => (name === 'LocalNotifications' ? ln : {}),
    };
    const { BedtimeReminder: BR, REMINDER_ID, ACTION_TYPE } = await import('../js/bedtime-reminder.js?native=1');
    const br = new BR();
    ok(br.supported, 'supported=true under a native runtime');

    const res = await br.enable({ hour: 23, minute: 0 });
    eq(res.ok, true, 'enable() succeeds');
    ok(calls.some((c) => c[0] === 'requestPermissions'), 'asks for notification permission');

    const reg = calls.find((c) => c[0] === 'registerActionTypes');
    ok(reg && reg[1].types[0].id === ACTION_TYPE, 'registers the action type');
    const actionIds = reg ? reg[1].types[0].actions.map((a) => a.id) : [];
    ok(actionIds.includes('start') && actionIds.includes('later'), 'offers Start and Not tonight actions');

    const sched = calls.find((c) => c[0] === 'schedule');
    const n = sched && sched[1].notifications[0];
    ok(n, 'schedule() called');
    eq(n?.id, REMINDER_ID, 'uses the fixed reminder id');
    eq(n?.actionTypeId, ACTION_TYPE, 'attaches the action type');
    ok(n?.schedule?.on?.hour === 23 && n?.schedule?.on?.minute === 0, 'repeats daily at 23:00 via schedule.on');
    const cancelIdx = calls.findIndex((c) => c[0] === 'cancel');
    const schedIdx = calls.findIndex((c) => c[0] === 'schedule');
    ok(cancelIdx >= 0 && cancelIdx < schedIdx, 'cancels the old reminder before rescheduling');

    // reschedule to a new time — registers actions only once
    calls.length = 0;
    await br.enable({ hour: 22, minute: 30 });
    ok(!calls.some((c) => c[0] === 'registerActionTypes'), 'action types registered only once');
    const n2 = calls.find((c) => c[0] === 'schedule')?.[1].notifications[0];
    ok(n2?.schedule?.on?.hour === 22 && n2?.schedule?.on?.minute === 30, 'reschedules to the new time');

    // actions
    const got = [];
    br.onAction((id) => got.push(id));
    const fire = listeners.localNotificationActionPerformed;
    ok(typeof fire === 'function', 'listens for notification actions');
    fire({ actionId: 'start', notification: { id: REMINDER_ID } });
    fire({ actionId: 'tap', notification: { id: REMINDER_ID } });
    fire({ actionId: 'start', notification: { id: 999 } }); // someone else's notification
    eq(got.join(','), 'start,tap', 'forwards only the bedtime reminder actions');

    // disable
    calls.length = 0;
    await br.disable();
    const c = calls.find((x) => x[0] === 'cancel');
    eq(c?.[1].notifications[0].id, REMINDER_ID, 'disable() cancels the reminder');

    // permission denied
    perm = 'denied';
    grantOnRequest = false;
    calls.length = 0;
    const denied = await new BR().enable({ hour: 23, minute: 0 });
    eq(denied.ok, false, 'enable() fails when permission is denied');
    eq(denied.reason, 'permission', 'reports the permission reason');
    ok(!calls.some((x) => x[0] === 'schedule'), 'nothing scheduled without permission');

    delete globalThis.Capacitor;
    pass('native mode schedules a daily reminder with actions');
  }
}
