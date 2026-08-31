# SleepSensor — accounts & cloud sync (Firebase)

Optional. Until you fill in `js/firebase-config.js` the app runs exactly as it
does now — 100 % on-device, no accounts. Once configured you get:

- **Guest (anonymous)** sign-in — one tap, no signup, upgradeable later
- **Email/password**, **Google**, **Apple** sign-in
- Sleep **stats** (sessions, events, loudest-moment metadata) sync per-account
  across devices via Firestore, offline-first
- **Audio clips never sync** — they stay in the device's IndexedDB, so the
  privacy promise holds and there's no storage bill

What the client code already does: `js/firebase.js` (SDK loader),
`js/auth.js` (`AuthManager`), `js/sync.js` (`SyncManager`), the auth screen in
`index.html`, and the Account section in Settings.

---

## STATUS — project `sleep-38ea4` (done for you)

Already set up and committed:

- ✅ Firebase project `sleep-38ea4` + web app `sleepsensor-web` created
- ✅ Real config written into `js/firebase-config.js` (committed — these are not
  secrets)
- ✅ Firestore `(default)` database created (region `nam5`)
- ✅ Security rules (`firestore.rules`) deployed to `cloud.firestore`
- ✅ `AUTH_METHODS`: guest + email + google enabled, apple off

### ⚠️ You still have to do this by hand (Console UI — I can't script it)

1. **Enable sign-in providers.**
   [Console → Authentication](https://console.firebase.google.com/u/0/project/sleep-38ea4/authentication/providers)
   → **Get started**, then **Sign-in method** tab → enable:
   - **Anonymous** — toggle on, Save
   - **Email/Password** — toggle on (leave "Email link" off), Save
   - **Google** — toggle on, pick your email as the support email, Save
2. **Authorized domains.**
   [Console → Authentication → Settings → Authorized domains](https://console.firebase.google.com/u/0/project/sleep-38ea4/authentication/settings)
   → **Add domain** → `sleepsensor.vercel.app`. (`localhost` and
   `sleep-38ea4.firebaseapp.com` are already there.)

Until step 1 is done, the auth screen appears but every sign-in button fails
with `auth/operation-not-allowed` / `auth/configuration-not-found`.

There is also a stray empty project `sleepsensor-app` (created by mistake before
you shared `sleep-38ea4`). Harmless — delete it at
Console → Project settings → General → Delete project if you want.

---

## 1. Create the Firebase project (~5 min)

1. <https://console.firebase.google.com> → **Add project**. Name it
   `sleepsensor` (or anything). Google Analytics optional.
2. In the project, click the **`</>` (Web)** icon to "Add app". Nickname
   `sleepsensor-web`. **Skip** "Firebase Hosting" (you're on Vercel).
3. Copy the `firebaseConfig` object it shows you.

## 2. Paste the config

Open `js/firebase-config.js` and replace the placeholder values:

```js
export const FIREBASE_CONFIG = {
  apiKey: 'AIza…',
  authDomain: 'sleepsensor-xxxx.firebaseapp.com',
  projectId: 'sleepsensor-xxxx',
  storageBucket: 'sleepsensor-xxxx.appspot.com',
  messagingSenderId: '…',
  appId: '1:…:web:…',
};
```

> These values are **not secrets** — they identify your project publicly. Real
> security comes from the Firestore rules in step 5. Committing them is fine.

Toggle which buttons appear in `AUTH_METHODS` in the same file (only enable ones
you turn on in step 3).

## 3. Enable sign-in providers

Console → **Authentication** → **Get started** → **Sign-in method** tab:

| Provider | Setup |
| --- | --- |
| **Anonymous** | Toggle on. Done. |
| **Email/Password** | Toggle on. (Leave "Email link" off.) |
| **Google** | Toggle on, pick a support email, Save. |
| **Apple** | Toggle on. Needs an **Apple Developer account** — see step 6. |

Then **Authentication → Settings → Authorized domains**: add `localhost`,
`sleepsensor.vercel.app`, and any custom domain. (Firebase adds the
`*.firebaseapp.com` one automatically.)

## 4. Create Firestore

Console → **Firestore Database** → **Create database** → **Production mode** →
pick a region close to your users → Enable.

## 5. Deploy the security rules (important)

```bash
npm i -g firebase-tools           # once
firebase login
firebase use --add                # pick your project, alias it "default"
firebase deploy --only firestore:rules
```

`firestore.rules` (in the repo root) locks every read/write to
`users/{uid}/…` where `uid == request.auth.uid`, and only for the
`sessions` / `events` / `highlights` collections. Nothing else is reachable.

## 6. Apple sign-in (only if you enabled it)

1. Apple Developer → **Certificates, Identifiers & Profiles**:
   - an **App ID** with "Sign in with Apple" capability
   - a **Services ID** (this is your Apple "client id"); set its web domain to
     `sleepsensor-xxxx.firebaseapp.com` and return URL to
     `https://sleepsensor-xxxx.firebaseapp.com/__/auth/handler`
   - a **Key** with "Sign in with Apple" enabled — download the `.p8`
2. Firebase → Authentication → Apple provider: fill in Services ID, Apple Team
   ID, Key ID, and the private key from the `.p8`.

If you're not shipping an iOS build, you can skip Apple and set
`AUTH_METHODS.apple = false`.

## 7. Google sign-in in the Capacitor app

`signInWithPopup` works in the iOS/Android WebView, but the native experience is
better with the plugin:

```bash
npm i @capacitor-firebase/authentication
npx cap sync
```

Then follow that plugin's iOS/Android setup (adds `GoogleService-Info.plist` /
`google-services.json` and a URL scheme). `js/auth.js` already falls back to
`signInWithRedirect` if the popup is blocked, so the web SDK path works too.

---

## How sync behaves

- On sign-in (guest or real): a full two-way sync — remote rows missing locally
  are pulled in, local rows missing remotely are pushed up, and where both exist
  the newer `updatedAt` wins.
- After each recording ends: that night's session + events + highlights are
  pushed.
- On app foreground / reconnect: another full sync, then the history & report
  screens refresh.
- Offline: Firestore queues writes and replays them; the local IndexedDB is
  always the immediate source of truth for the UI.
- "Clear All Data" while signed in also wipes the account (`purgeRemote()`),
  after a clear confirmation.
- A guest who signs in with Google/Apple/email keeps their data — we
  `linkWithCredential` the anonymous user. If that Google/Apple account already
  has a SleepSensor account, we sign into that one instead (the guest's local
  data stays on the device and merges on next sync).

## Local testing with the emulator

```bash
firebase emulators:start --only auth,firestore
```

Point the app at it by adding this to the top of `getFirebase()` in
`js/firebase.js` (dev only — don't commit):

```js
authFns.connectAuthEmulator(auth, 'http://localhost:9099');
dbFns.connectFirestoreEmulator(db, 'localhost', 8080);
```

`tests/test-sync.mjs` exercises the merge logic against an in-memory fake
Firestore and needs no emulator.

## Cost

Firestore free tier: 50 K reads + 20 K writes + 1 GiB storage per day. A night
of sleep is ~5–40 tiny docs. A typical user is well within free limits; even
thousands of users cost cents. Audio clips are never uploaded.
