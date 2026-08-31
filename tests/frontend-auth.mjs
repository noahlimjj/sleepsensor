// Frontend auth/sync UI: serves a CONFIGURED firebase-config.js + fake Firebase
// SDK modules, then checks the auth screen shows, guest sign-in works, the app
// proceeds, a recording syncs, and the Settings account section reflects state.
import { createServer } from 'http';
import { readFile, stat } from 'fs/promises';
import { join, extname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PW = '/Users/User/.nvm/versions/node/v22.18.0/lib/node_modules/playwright/index.js';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.wav': 'audio/wav' };

const CONFIGURED = `
export const FIREBASE_CONFIG = { apiKey:'AIzaTESTKEY', authDomain:'t.firebaseapp.com', projectId:'test-proj', storageBucket:'t.appspot.com', messagingSenderId:'1', appId:'1:1:web:abc' };
export const FIREBASE_SDK_VERSION = '10.13.0';
export const AUTH_METHODS = { guest:true, email:true, google:true, apple:true };
export function firebaseConfigured(){ return true; }
`;

let fails = 0;
const check = (c, m) => { console.log(`  ${c ? '✓' : '✗'} ${m}`); if (!c) fails++; };

async function main() {
  const wav = join(ROOT, 'tests/fixtures/snore.wav');
  if (!existsSync(wav)) execFileSync('node', [join(ROOT, 'tests/fixtures/gen-audio.mjs')], { stdio: 'inherit' });

  const server = createServer(async (req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';

    // swap in a configured firebase-config
    if (p === '/js/firebase-config.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      return res.end(CONFIGURED);
    }
    // redirect the Firebase CDN imports to local fakes
    const cdn = p.match(/\/gstatic-firebasejs\/firebase-(app|auth|firestore)\.js$/);
    if (cdn) {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      return res.end(await readFile(join(ROOT, 'tests/fixtures/fake-firebase', cdn[1] + '.js')));
    }

    const fp = join(ROOT, p);
    const s = await stat(fp).catch(() => null);
    if (!s || !s.isFile()) { res.writeHead(404).end('nf'); return; }
    let body = await readFile(fp);
    if (p === '/js/firebase.js') {
      body = body.toString().replace(
        'const CDN = (m) => `https://www.gstatic.com/firebasejs/${V}/firebase-${m}.js`;',
        'const CDN = (m) => `/gstatic-firebasejs/firebase-${m}.js`;'
      );
    }
    res.writeHead(200, { 'content-type': MIME[extname(fp)] || 'application/octet-stream' });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  const { chromium } = createRequire(import.meta.url)(PW);
  const browser = await chromium.launch({
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });

  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['microphone'] });
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
    await page.addInitScript(() => {
      window.__fm = async () => {
        const pr = new AudioContext();
        const buf = await pr.decodeAudioData(await (await fetch('/tests/fixtures/snore.wav')).arrayBuffer());
        navigator.mediaDevices.getUserMedia = async () => {
          const ac = new AudioContext();
          const d = ac.createMediaStreamDestination();
          const s = ac.createBufferSource();
          s.buffer = buf; s.loop = true; s.connect(d); s.start();
          return d.stream;
        };
      };
    });

    console.log('\n▸ auth screen gates the app');
    await page.goto(base + '/', { waitUntil: 'load' });
    await page.evaluate(() => window.__fm());
    await page.waitForSelector('#auth-screen:not([hidden])', { timeout: 12000 });
    check(true, 'auth screen shows when Firebase is configured and no user');
    check(await page.locator('#app[hidden]').count() === 1, 'main app stays hidden until sign-in');
    check(await page.locator('#auth-guest:not([hidden])').count() === 1, 'guest button visible');
    check(await page.locator('#auth-google:not([hidden])').count() === 1, 'google button visible');

    console.log('\n▸ continue as guest');
    await page.click('#auth-guest');
    await page.waitForSelector('#app:not([hidden])', { timeout: 12000 });
    await page.waitForFunction(() => document.getElementById('auth-screen').hidden, null, { timeout: 8000 });
    check(true, 'guest sign-in dismisses the auth screen and shows the app');

    console.log('\n▸ settings shows the account + upgrade prompt');
    await page.click('#nav-settings');
    await page.waitForTimeout(300);
    check(await page.locator('#account-section:not([hidden])').count() === 1, 'account section visible');
    check((await page.textContent('#account-name')).trim() === 'Guest', 'shows "Guest"');
    check(await page.locator('#account-signin-btn:not([hidden])').count() === 1, 'offers "Sign in / Create account"');

    console.log('\n▸ record a session → it syncs');
    await page.click('#nav-record');
    await page.click('#record-btn');
    await page.waitForSelector('#app.recording', { timeout: 8000 });
    await page.waitForTimeout(15000);
    await page.click('#record-btn');
    await page.waitForSelector('#screen-report.active', { timeout: 8000 });
    await page.waitForTimeout(1500);
    const synced = await page.evaluate(async () => {
      const { __store } = await import('/gstatic-firebasejs/firebase-firestore.js');
      const keys = [...__store().keys()];
      return {
        sessions: keys.filter((k) => k.includes('/sessions/')).length,
        events: keys.filter((k) => k.includes('/events/')).length,
        anyBlob: keys.some((k) => JSON.stringify(__store().get(k)).includes('audioBlob')),
      };
    });
    check(synced.sessions >= 1, `session pushed to Firestore (${synced.sessions})`);
    check(!synced.anyBlob, 'no audioBlob was ever written to Firestore');

    console.log('\n▸ upgrade guest → Google keeps the session');
    await page.click('#nav-settings');
    await page.waitForTimeout(200);
    await page.click('#account-signin-btn');
    await page.waitForSelector('#auth-screen:not([hidden])');
    await page.click('#auth-google');
    await page.waitForTimeout(800);
    check(/example\.com|Popup|Linked/.test(await page.textContent('#account-name')) || (await page.textContent('#account-status')).includes('@'),
      'account upgraded to a real sign-in');

    console.log('\n▸ errors');
    const benign = (t) => /favicon|fonts\.g|Failed to load resource/i.test(t);
    const real = errors.filter((e) => !benign(e));
    check(real.length === 0, real.length ? 'errors: ' + real.slice(0, 5).join(' | ') : 'no console / page errors through the auth flow');
  } finally {
    await browser.close();
    server.close();
  }

  console.log(`\n${'─'.repeat(48)}`);
  console.log(fails ? `  frontend auth: ${fails} failed` : '  frontend auth: all checks passed');
  process.exit(fails ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
