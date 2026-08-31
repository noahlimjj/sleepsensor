/*
 * firebase.js — SleepSensor
 *
 * Lazily loads the Firebase modular SDK from Google's CDN (works with no
 * bundler), initialises the app + Auth + Firestore, and turns on Firestore's
 * offline persistence so the app keeps working with no connection.
 *
 * getFirebase() resolves to null when firebase-config.js still holds
 * placeholders — callers must handle that and fall back to local-only mode.
 */

import { FIREBASE_CONFIG, FIREBASE_SDK_VERSION, firebaseConfigured } from './firebase-config.js';

const V = FIREBASE_SDK_VERSION;
const CDN = (m) => `https://www.gstatic.com/firebasejs/${V}/firebase-${m}.js`;

let _promise = null;

/**
 * @returns {Promise<null | {
 *   app, auth, db,
 *   authFns: typeof import('firebase/auth'),
 *   dbFns:   typeof import('firebase/firestore'),
 * }>}
 */
export function getFirebase() {
  if (!firebaseConfigured()) return Promise.resolve(null);
  if (_promise) return _promise;

  _promise = (async () => {
    const [{ initializeApp, getApps }, authFns, dbFns] = await Promise.all([
      import(CDN('app')),
      import(CDN('auth')),
      import(CDN('firestore')),
    ]);

    const app = getApps().length ? getApps()[0] : initializeApp(FIREBASE_CONFIG);
    const auth = authFns.getAuth(app);
    try {
      await authFns.setPersistence(auth, authFns.browserLocalPersistence);
    } catch (_) {
      /* private mode — session persistence is the fallback */
    }

    // Firestore with multi-tab offline persistence; degrade gracefully.
    let db;
    try {
      db = dbFns.initializeFirestore(app, {
        localCache: dbFns.persistentLocalCache({ tabManager: dbFns.persistentMultipleTabManager() }),
      });
    } catch (_) {
      db = dbFns.getFirestore(app);
    }

    return { app, auth, db, authFns, dbFns };
  })().catch((err) => {
    console.warn('[firebase] init failed — running local-only:', err && err.message);
    _promise = null;
    return null;
  });

  return _promise;
}
