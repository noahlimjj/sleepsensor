/*
 * bedtime-reminder.js — SleepSensor
 *
 * A daily local notification ("Time for bed? Start SleepSensor") at a time the
 * user picks in Settings. Built on @capacitor/local-notifications, so it only
 * works in the native iOS / Android shell — on the plain web every method is a
 * safe no-op and `supported` is false.
 *
 * The notification carries two actions:
 *   - "start" : opens the app and starts monitoring straight away
 *   - "later" : dismisses it for tonight
 * Tapping the notification body (actionId "tap") opens the app and asks.
 *
 * No build step / imports: the Capacitor runtime injects `window.Capacitor`.
 */

const Cap = typeof globalThis !== 'undefined' ? globalThis.Capacitor : undefined;
const IS_NATIVE = !!(Cap && typeof Cap.isNativePlatform === 'function' && Cap.isNativePlatform());

// fixed id so re-scheduling replaces the previous reminder instead of stacking
export const REMINDER_ID = 2300;
export const ACTION_TYPE = 'SLEEPSENSOR_BEDTIME';

function plugin(name) {
  try {
    if (Cap && typeof Cap.registerPlugin === 'function') return Cap.registerPlugin(name);
    if (Cap && Cap.Plugins && Cap.Plugins[name]) return Cap.Plugins[name];
  } catch (_) {
    /* ignore */
  }
  return null;
}

/** Parse "HH:MM" (the <input type="time"> value) -> { hour, minute } or null. */
export function parseTime(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

export class BedtimeReminder {
  constructor() {
    this._ln = IS_NATIVE ? plugin('LocalNotifications') : null;
    this._actionsRegistered = false;
    this._listeners = [];
  }

  /** True when local notifications are actually usable. */
  get supported() {
    return !!this._ln;
  }

  async _registerActions() {
    if (this._actionsRegistered) return;
    try {
      await this._ln.registerActionTypes({
        types: [
          {
            id: ACTION_TYPE,
            actions: [
              { id: 'start', title: 'Start SleepSensor', foreground: true },
              { id: 'later', title: 'Not tonight', destructive: true },
            ],
          },
        ],
      });
      this._actionsRegistered = true;
    } catch (err) {
      // actions are a nicety — the plain notification still works
      console.warn('[BedtimeReminder] registerActionTypes failed:', err?.message || err);
    }
  }

  /** Ask for notification permission if needed. Resolves true when granted. */
  async ensurePermission() {
    if (!this.supported) return false;
    try {
      const cur = await this._ln.checkPermissions();
      if (cur && cur.display === 'granted') return true;
      const req = await this._ln.requestPermissions();
      return !!(req && req.display === 'granted');
    } catch (_) {
      return false;
    }
  }

  /**
   * Schedule (or re-schedule) the daily reminder.
   * @param {{hour:number, minute:number}} time
   * @returns {Promise<{ok:boolean, reason?:string}>}
   */
  async enable({ hour, minute }) {
    if (!this.supported) return { ok: false, reason: 'unsupported' };
    if (!(await this.ensurePermission())) return { ok: false, reason: 'permission' };
    await this._registerActions();
    await this.disable();
    try {
      await this._ln.schedule({
        notifications: [
          {
            id: REMINDER_ID,
            title: 'Time for bed? 🌙',
            body: 'Start SleepSensor to track snoring and grinding tonight.',
            actionTypeId: ACTION_TYPE,
            extra: { kind: 'bedtime-reminder' },
            // `on` repeats daily on both iOS and Android
            schedule: { on: { hour, minute }, allowWhileIdle: true },
          },
        ],
      });
      return { ok: true };
    } catch (err) {
      console.warn('[BedtimeReminder] schedule failed:', err?.message || err);
      return { ok: false, reason: 'schedule' };
    }
  }

  /** Cancel the daily reminder. */
  async disable() {
    if (!this.supported) return;
    try {
      await this._ln.cancel({ notifications: [{ id: REMINDER_ID }] });
    } catch (_) {
      /* nothing scheduled */
    }
  }

  /**
   * Called when the user interacts with the reminder.
   * @param {(actionId: 'start'|'later'|'tap'|string) => void} cb
   */
  onAction(cb) {
    if (!this.supported || !cb) return;
    try {
      const h = this._ln.addListener('localNotificationActionPerformed', (e) => {
        const n = e && e.notification;
        if (!n || (n.id !== REMINDER_ID && n.extra?.kind !== 'bedtime-reminder')) return;
        cb(e.actionId || 'tap');
      });
      this._listeners.push(h);
    } catch (_) {
      /* older shell */
    }
  }

  async dispose() {
    for (const h of this._listeners) {
      try {
        (await h)?.remove?.();
      } catch (_) {
        /* ignore */
      }
    }
    this._listeners = [];
  }
}

export const bedtimeReminder = new BedtimeReminder();
export default BedtimeReminder;
