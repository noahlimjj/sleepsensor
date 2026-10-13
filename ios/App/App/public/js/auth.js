/*
 * auth.js — SleepSensor
 *
 * Firebase Authentication wrapper. Supports guest (anonymous), email/password,
 * Google and Apple. A guest can later "keep their account" — we link the new
 * credential to the anonymous user so their synced data carries over.
 *
 * When Firebase isn't configured, `available` is false and the app treats the
 * user as an implicit local-only guest.
 */

import { getFirebase } from './firebase.js';
import { AUTH_METHODS } from './firebase-config.js';

export class AuthManager {
  constructor() {
    this.available = false;
    this.methods = AUTH_METHODS;
    this.user = null; // firebase User | null
    this._fb = null;
    this._listeners = new Set();
    this._ready = null;
  }

  /** Resolves once the initial auth state is known (or immediately if no Firebase). */
  init() {
    if (this._ready) return this._ready;
    this._ready = (async () => {
      const fb = await getFirebase();
      if (!fb) return; // local-only mode
      this._fb = fb;
      this.available = true;
      await new Promise((resolve) => {
        let first = true;
        fb.authFns.onAuthStateChanged(fb.auth, (user) => {
          this.user = user;
          this._emit();
          if (first) {
            first = false;
            resolve();
          }
        });
      });
    })();
    return this._ready;
  }

  get uid() {
    return this.user ? this.user.uid : null;
  }
  get isGuest() {
    return !!this.user && this.user.isAnonymous;
  }
  get signedIn() {
    return !!this.user && !this.user.isAnonymous;
  }
  get email() {
    return this.user ? this.user.email : null;
  }
  get displayName() {
    return this.user ? this.user.displayName || this.user.email || 'Guest' : null;
  }

  onChange(cb) {
    this._listeners.add(cb);
    cb(this._state());
    return () => this._listeners.delete(cb);
  }
  _state() {
    return { user: this.user, uid: this.uid, isGuest: this.isGuest, signedIn: this.signedIn };
  }
  _emit() {
    for (const cb of this._listeners) {
      try {
        cb(this._state());
      } catch (e) {
        console.warn('[auth] listener threw', e);
      }
    }
  }

  // ---- sign-in flows -------------------------------------------------
  async signInGuest() {
    this._need();
    await this._fb.authFns.signInAnonymously(this._fb.auth);
  }

  async signUpEmail(email, password) {
    this._need();
    const f = this._fb.authFns;
    if (this.isGuest) return this._link(f.EmailAuthProvider.credential(email, password));
    await f.createUserWithEmailAndPassword(this._fb.auth, email, password);
  }

  async signInEmail(email, password) {
    this._need();
    await this._fb.authFns.signInWithEmailAndPassword(this._fb.auth, email, password);
  }

  async sendPasswordReset(email) {
    this._need();
    await this._fb.authFns.sendPasswordResetEmail(this._fb.auth, email);
  }

  async signInGoogle() {
    this._need();
    const f = this._fb.authFns;
    const provider = new f.GoogleAuthProvider();
    return this._oauth(provider);
  }

  async signInApple() {
    this._need();
    const f = this._fb.authFns;
    const provider = new f.OAuthProvider('apple.com');
    provider.addScope('email');
    provider.addScope('name');
    return this._oauth(provider);
  }

  async signOut() {
    if (!this.available) return;
    await this._fb.authFns.signOut(this._fb.auth);
  }

  // ---- internals ---------------------------------------------------
  async _oauth(provider) {
    const f = this._fb.authFns;
    try {
      if (this.isGuest) {
        await f.linkWithPopup(this.user, provider);
      } else {
        await f.signInWithPopup(this._fb.auth, provider);
      }
    } catch (err) {
      if (err && (err.code === 'auth/popup-blocked' || err.code === 'auth/operation-not-supported-in-this-environment')) {
        // webview / popup-blocked: fall back to a full-page redirect
        await f.signInWithRedirect(this._fb.auth, provider);
        return;
      }
      if (err && err.code === 'auth/credential-already-in-use') {
        // the Google/Apple account already has a SleepSensor account — just sign
        // into it (the guest's local data stays on this device)
        await f.signInWithCredential(this._fb.auth, f.OAuthProvider.credentialFromError(err));
        return;
      }
      throw err;
    }
  }

  async _link(credential) {
    try {
      await this._fb.authFns.linkWithCredential(this.user, credential);
    } catch (err) {
      if (err && err.code === 'auth/email-already-in-use') {
        await this._fb.authFns.signInWithCredential(this._fb.auth, credential);
        return;
      }
      throw err;
    }
  }

  _need() {
    if (!this.available) throw new Error('Accounts are not configured for this build.');
  }
}

export const authManager = new AuthManager();
export default AuthManager;
