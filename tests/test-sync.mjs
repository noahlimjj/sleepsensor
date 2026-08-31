// sync.js — two-way stats sync against an in-memory fake Firestore.
import 'fake-indexeddb/auto';
import { section, ok, eq, pass } from './lib.mjs';
import { Storage } from '../js/storage.js';
import { SyncManager } from '../js/sync.js';

// ---- minimal fake Firestore (just what sync.js touches) ----
function fakeFirestore() {
  const store = new Map(); // 'users/u/sessions/id' -> data
  const path = (p) => p.join('/');
  const dbFns = {
    collection: (_db, ...p) => ({ _p: path(p) }),
    doc: (_db, ...p) => ({ _p: path(p) }),
    serverTimestamp: () => ({ __ts: true }),
    getDocs: async (ref) => {
      const prefix = ref._p + '/';
      const docs = [];
      for (const [k, v] of store) {
        if (k.startsWith(prefix) && k.slice(prefix.length).indexOf('/') === -1) {
          docs.push({ id: k.slice(prefix.length), data: () => ({ ...v }) });
        }
      }
      return { forEach: (cb) => docs.forEach(cb), size: docs.length };
    },
    writeBatch: () => {
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
    },
  };
  return { db: {}, dbFns, _store: store };
}

const wire = () => ({ ...fakeFirestore() });

export async function run() {
  section('sync.js — cloud stats sync');

  const storage = new Storage();
  await storage.init();
  await storage.clearAll();

  // local: one session with an event + highlight
  const s1 = await storage.createSession({ startTime: 1000, endTime: 2000 });
  await storage.updateSession(s1.id, { snoringDuration: 300, updatedAt: 5000 });
  const e1 = await storage.addEvent({ id: 'ev1', sessionId: s1.id, type: 'snoring', startTime: 1100, endTime: 1400, updatedAt: 5000 });
  await storage.saveHighlight({ id: 'hl1', sessionId: s1.id, timestamp: 1200, peak: 0.5, db: -6, updatedAt: 5000 });
  const clip = await storage.saveClip({ eventId: 'ev1', sessionId: s1.id, clipType: 'event', audioBlob: new Blob([new Uint8Array(999)]) });

  const fb = wire();
  // remote: a different session the local device has never seen
  fb._store.set('users/U/sessions/remoteSess', { id: 'remoteSess', startTime: 9000, endTime: 9500, snoringDuration: 120, updatedAt: 8000 });
  fb._store.set('users/U/events/remoteEv', { id: 'remoteEv', sessionId: 'remoteSess', type: 'bruxism', updatedAt: 8000 });
  // remote also has s1 but STALE
  fb._store.set('users/U/sessions/' + s1.id, { id: s1.id, startTime: 1000, endTime: 2000, snoringDuration: 1, updatedAt: 1 });

  const sync = new SyncManager(storage);
  await sync.attach(fb, 'U');

  // --- remote -> local ---
  const remoteSess = await storage.getSession('remoteSess');
  ok(remoteSess && remoteSess.snoringDuration === 120, 'remote-only session pulled into local storage');
  ok((await storage._allEvents()).some((e) => e.id === 'remoteEv'), 'remote-only event pulled in');

  // --- local -> remote ---
  ok(fb._store.has('users/U/events/ev1'), 'local-only event pushed to Firestore');
  ok(fb._store.has('users/U/highlights/hl1'), 'local-only highlight pushed');

  // --- newer wins (local updatedAt 5000 > remote 1) ---
  eq(fb._store.get('users/U/sessions/' + s1.id).snoringDuration, 300, 'local (newer) session overwrote the stale remote copy');
  eq((await storage.getSession(s1.id)).snoringDuration, 300, 'local session kept its newer value');

  // --- audio never leaves the device ---
  ok(!('audioBlob' in (fb._store.get('users/U/events/ev1') || {})), 'audioBlob is never written to Firestore');
  ok(await storage.getClip(clip.id), 'the local clip is untouched');

  // --- pushSession after a recording ---
  const s2 = await storage.createSession({ startTime: 20000, endTime: 21000 });
  await storage.addEvent({ id: 'ev2', sessionId: s2.id, type: 'noise' });
  await sync.pushSession(s2.id);
  ok(fb._store.has('users/U/sessions/' + s2.id), 'pushSession uploaded the new session');
  ok(fb._store.has('users/U/events/ev2'), 'pushSession uploaded its events');

  // --- tombstone: remote deletion removes the local row on next sync ---
  fb._store.set('users/U/sessions/remoteSess', { id: 'remoteSess', deleted: true, updatedAt: 99999 });
  await sync.sync();
  eq(await storage.getSession('remoteSess'), null, 'a remote { deleted:true } tombstone deletes the local row');

  // --- purgeRemote wipes the account ---
  await sync.purgeRemote();
  const left = [...fb._store.keys()].filter((k) => k.startsWith('users/U/'));
  eq(left.length, 0, 'purgeRemote() empties every collection');

  // --- detach is clean ---
  sync.detach();
  eq(sync.uid, null, 'detach clears the uid');

  storage.close();
  pass('cloud sync merges correctly and never uploads audio');
}
