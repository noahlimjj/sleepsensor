// Minimal fake of firebase-auth.js for UI tests.
let _user = null;
const _cbs = new Set();
function emit() {
  for (const cb of _cbs) cb(_user);
}
function mkUser(over) {
  return { uid: 'test-uid-' + Math.random().toString(36).slice(2), isAnonymous: false, email: null, displayName: null, ...over };
}

export function getAuth() {
  return { _fake: true };
}
export async function setPersistence() {}
export const browserLocalPersistence = 'local';
export function onAuthStateChanged(_auth, cb) {
  _cbs.add(cb);
  Promise.resolve().then(() => cb(_user));
  return () => _cbs.delete(cb);
}
export async function signInAnonymously() {
  _user = mkUser({ isAnonymous: true, displayName: 'Guest' });
  emit();
  return { user: _user };
}
export async function signInWithEmailAndPassword(_a, email) {
  if (!email || !email.includes('@')) {
    const e = new Error('bad email');
    e.code = 'auth/invalid-email';
    throw e;
  }
  _user = mkUser({ email });
  emit();
  return { user: _user };
}
export async function createUserWithEmailAndPassword(_a, email) {
  _user = mkUser({ email });
  emit();
  return { user: _user };
}
export async function sendPasswordResetEmail() {}
export async function signInWithPopup(_a, provider) {
  _user = mkUser({ email: 'popup@example.com', displayName: 'Popup User', providerId: provider.providerId });
  emit();
  return { user: _user };
}
export async function linkWithPopup(user, provider) {
  _user = { ...user, isAnonymous: false, email: 'linked@example.com', displayName: 'Linked', providerId: provider.providerId };
  emit();
  return { user: _user };
}
export async function linkWithCredential(user, cred) {
  _user = { ...user, isAnonymous: false, email: cred.email || 'linked@example.com' };
  emit();
  return { user: _user };
}
export async function signInWithCredential(_a, cred) {
  _user = mkUser({ email: cred.email || 'cred@example.com' });
  emit();
  return { user: _user };
}
export async function signInWithRedirect() {}
export async function signOut() {
  _user = null;
  emit();
}
export class GoogleAuthProvider {
  constructor() { this.providerId = 'google.com'; }
  addScope() {}
}
export class OAuthProvider {
  constructor(id) { this.providerId = id; }
  addScope() {}
  static credentialFromError() { return { email: 'apple@example.com' }; }
}
export const EmailAuthProvider = {
  credential: (email, password) => ({ email, password, providerId: 'password' }),
};
export function connectAuthEmulator() {}
