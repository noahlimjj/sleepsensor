// Minimal fake of firebase-firestore.js for UI tests (in-memory store).
const store = new Map();
const P = (p) => p.join('/');

export function initializeFirestore() {
  return { _fake: true };
}
export function getFirestore() {
  return { _fake: true };
}
export function persistentLocalCache() {
  return {};
}
export function persistentMultipleTabManager() {
  return {};
}
export function connectFirestoreEmulator() {}
export function collection(_db, ...p) {
  return { _p: P(p) };
}
export function doc(_db, ...p) {
  return { _p: P(p) };
}
export function serverTimestamp() {
  return { __ts: Date.now() };
}
export async function getDocs(ref) {
  const prefix = ref._p + '/';
  const docs = [];
  for (const [k, v] of store) {
    if (k.startsWith(prefix) && !k.slice(prefix.length).includes('/')) {
      docs.push({ id: k.slice(prefix.length), data: () => ({ ...v }) });
    }
  }
  return { forEach: (cb) => docs.forEach(cb), size: docs.length };
}
export function writeBatch() {
  const ops = [];
  return {
    set: (ref, data) => ops.push(['set', ref._p, data]),
    delete: (ref) => ops.push(['del', ref._p]),
    commit: async () => {
      for (const [op, p, data] of ops) {
        if (op === 'set') store.set(p, { ...(store.get(p) || {}), ...data });
        else store.delete(p);
      }
    },
  };
}
export function __store() {
  return store;
}
