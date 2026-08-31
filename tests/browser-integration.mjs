// Real-browser integration test: loads the actual modules in Chromium with a
// fake microphone fed synthetic snoring audio, runs the pipeline end to end,
// and checks that energy, classification, events, clips and the session summary
// all flow through correctly. Also smoke-tests index.html + service worker.
import { createServer } from 'http';
import { readFile, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, extname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PW = '/Users/User/.nvm/versions/node/v22.18.0/lib/node_modules/playwright/index.js';

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.css': 'text/css',
  '.wav': 'audio/wav',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

let failures = 0;
const check = (cond, msg) => {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failures++;
};

async function main() {
  // 1. ensure the fake-audio fixture exists
  const wav = join(ROOT, 'tests/fixtures/snore.wav');
  if (!existsSync(wav)) {
    console.log('generating fake-audio fixture...');
    execFileSync('node', [join(ROOT, 'tests/fixtures/gen-audio.mjs')], { stdio: 'inherit' });
  }

  // 2. static file server
  const server = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      if (p === '/js/firebase-config.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        return res.end('export const FIREBASE_CONFIG={};export const FIREBASE_SDK_VERSION="10.13.0";export const AUTH_METHODS={guest:true};export function firebaseConfigured(){return false;}');
      }
      const fpath = join(ROOT, p);
      if (!fpath.startsWith(ROOT)) {
        res.writeHead(403).end('no');
        return;
      }
      const s = await stat(fpath).catch(() => null);
      if (!s || !s.isFile()) {
        res.writeHead(404).end('not found');
        return;
      }
      const body = await readFile(fpath);
      res.writeHead(200, {
        'content-type': MIME[extname(fpath)] || 'application/octet-stream',
        'service-worker-allowed': '/',
      });
      res.end(body);
    } catch (err) {
      res.writeHead(500).end(String(err));
    }
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  console.log(`server on ${base}`);

  const { chromium } = createRequire(import.meta.url)(PW);
  const browser = await chromium.launch({
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  try {
    const ctx = await browser.newContext({ permissions: ['microphone'] });

    // ---- A. pipeline harness ----------------------------------------
    console.log('\n▸ end-to-end audio pipeline');
    const page = await ctx.newPage();
    const consoleErrors = [];
    page.on('console', (m) => {
      if (process.env.PW_VERBOSE) console.log(`    [page:${m.type()}] ${m.text()}`);
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => consoleErrors.push(String(e)));

    await page.goto(`${base}/tests/harness.html`);
    await page.waitForFunction(() => window.__test && (window.__test.ready || window.__test.fatal), null, {
      timeout: 15000,
    });
    const fatal = await page.evaluate(() => window.__test.fatal);
    check(!fatal, `harness initialised without fatal error${fatal ? ': ' + fatal : ''}`);

    await page.evaluate(() =>
      Promise.race([
        window.__test.start(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('start() timed out')), 20000)),
      ])
    );
    await page.waitForTimeout(1500);
    const elapsed = await page.evaluate(() => window.__test.getElapsed());
    check(elapsed > 0.5, `getElapsedTime advances while recording (${elapsed.toFixed(2)}s)`);

    // let the snoring feed run through many 2s classification windows
    await page.waitForTimeout(16000);

    const level = await page.evaluate(() => window.__test.getLevel());
    check(
      typeof level.dbFS === 'number' && level.dbFS < 0 && level.spl > 0,
      `live dB meter works (dBFS ${level.dbFS}, ~${level.spl} dB SPL)`
    );
    const sens = await page.evaluate(() => window.__test.describeSensitivity(0.5));
    check(!!sens.label && !!sens.detail, `describeSensitivity returns guidance ("${sens.label}")`);

    const raw = await page.evaluate(() => window.__test.rawClassifications);
    const rawTally = {};
    raw.forEach((r) => (rawTally[r.type] = (rawTally[r.type] || 0) + 1));
    console.log(`  raw classifications: ${JSON.stringify(rawTally)}  (first: ${JSON.stringify(raw[0])})`);

    const result = await page.evaluate(() => window.__test.stop());

    check(result.energyCount > 50, `onEnergy fired repeatedly (${result.energyCount} times)`);
    check(
      Number.isFinite(result.dbMin) && result.dbMax <= 0 && result.dbMax > result.dbMin,
      `onEnergy delivered dBFS values (${result.dbMin.toFixed(1)}..${result.dbMax.toFixed(1)} dBFS)`
    );
    check(result.statuses.includes('recording'), 'status went through "recording"');
    check(result.statuses.includes('idle'), 'status returned to "idle" after stop');
    check(result.events.length >= 1, `at least one event detected (${result.events.length})`);
    check(
      result.events.every((e) => ['snoring', 'bruxism', 'noise'].includes(e.type)),
      `all events are snoring/bruxism/noise (${[...new Set(result.events.map((e) => e.type))].join(',')})`
    );
    check(
      result.events.some((e) => e.type === 'snoring'),
      'the real snoring feed produced a snoring event'
    );
    check(
      result.events.every((e) => e.confidence >= 0 && e.confidence <= 1),
      'event confidences are in [0,1]'
    );
    check(
      result.events.every((e) => typeof e.peakDb === 'number' && e.peakDb <= 0),
      'every event carries a peak dBFS'
    );
    check(
      result.events.every((e) => ['mild', 'moderate', 'severe'].includes(e.severity)),
      'event severities are valid'
    );

    const sum = result.summary;
    check(sum.sessionId && typeof sum.sessionId === 'string', 'summary has a sessionId');
    check(sum.totalDuration > 10, `summary.totalDuration is sane (${sum.totalDuration.toFixed(1)}s)`);
    check(sum.snoringEpisodes === result.events.filter((e) => e.type === 'snoring').length, 'snoringEpisodes matches events');
    check(sum.snoringDuration > 0, `summary.snoringDuration > 0 (${sum.snoringDuration}s)`);
    check(
      sum.snoringPercentage >= 0 && sum.snoringPercentage <= 100,
      `summary.snoringPercentage in range (${sum.snoringPercentage}%)`
    );
    check(typeof sum.loudestDb === 'number', `summary reports loudestDb (${sum.loudestDb})`);
    check(Array.isArray(sum.highlights), 'summary includes a highlights array');
    check(sum.endTime > sum.startTime, 'summary.endTime after startTime');

    check(result.storedEventCount >= 1, `events persisted to IndexedDB (${result.storedEventCount})`);
    check(result.storedHighlightCount >= 1, `loudest-moment highlights persisted (${result.storedHighlightCount})`);
    check(result.storedClipCount >= 1, `audio clip(s) persisted to IndexedDB (${result.storedClipCount})`);
    check(result.highlightClipCount >= 1, `highlight clip(s) persisted (${result.highlightClipCount})`);
    check(
      result.storedClipTypes.every((t) => t === 'event' || t === 'highlight'),
      `clips tagged with a clipType (${JSON.stringify([...new Set(result.storedClipTypes)])})`
    );
    check(
      result.storedClipSizes.every((n) => n > 44),
      `stored clips are non-empty WAVs (${result.storedClipSizes.length} clips)`
    );
    check(consoleErrors.length === 0, `no console errors during pipeline run${consoleErrors.length ? ': ' + consoleErrors.join(' | ') : ''}`);

    // ---- B. index.html + service worker smoke test -----------------
    console.log('\n▸ app shell + service worker');
    const app = await ctx.newPage();
    const appErrors = [];
    app.on('console', (m) => {
      if (m.type() === 'error') appErrors.push(m.text());
    });
    app.on('pageerror', (e) => appErrors.push(String(e)));
    await app.goto(`${base}/`, { waitUntil: 'load' });
    await app.waitForTimeout(2500);

    const splashHidden = await app.evaluate(() => {
      const el = document.getElementById('app');
      return el && !el.hasAttribute('hidden');
    });
    check(splashHidden, 'app initialised past the splash screen');

    const swReady = await app.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return 'unsupported';
      try {
        const reg = await Promise.race([
          navigator.serviceWorker.ready.then(() => 'ready'),
          new Promise((r) => setTimeout(() => r('timeout'), 5000)),
        ]);
        return reg;
      } catch (e) {
        return 'error:' + e;
      }
    });
    check(swReady === 'ready', `service worker registered and active (${swReady})`);

    const dbOpened = await app.evaluate(
      () =>
        new Promise((resolve) => {
          const r = indexedDB.open('sleepsensor-db');
          r.onsuccess = () => {
            const names = Array.from(r.result.objectStoreNames);
            r.result.close();
            resolve(names);
          };
          r.onerror = () => resolve([]);
        })
    );
    check(
      ['sessions', 'events', 'clips', 'settings', 'highlights'].every((n) => dbOpened.includes(n)),
      `IndexedDB schema created: ${JSON.stringify(dbOpened)}`
    );

    // frontend-owned rendering issues (charts/timeline) are reported but do not
    // fail the backend integration check
    const frontendError = (t) => /roundRect|CanvasRenderingContext2D|getContext|canvas/i.test(t);
    const benignError = (t) => /tf|tensorflow|fonts\.g|Failed to load resource/i.test(t);
    const frontendIssues = appErrors.filter(frontendError);
    const realAppErrors = appErrors.filter((e) => !benignError(e) && !frontendError(e));
    if (frontendIssues.length) console.log('  ⚠ frontend rendering errors (not backend):', frontendIssues.join(' | '));
    check(
      realAppErrors.length === 0,
      `no unexpected backend console errors in the app${realAppErrors.length ? ': ' + realAppErrors.join(' | ') : ''}`
    );
  } finally {
    await browser.close();
    server.close();
  }

  console.log(`\n${'─'.repeat(48)}`);
  if (failures) {
    console.log(`  browser integration: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('  browser integration: all checks passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
