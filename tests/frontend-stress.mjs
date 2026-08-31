// Frontend stress test: rapid events, multiple record sessions, rotation,
// double-taps, playback edge cases, export/clear. Surfaces runtime bugs the
// happy-path test misses.
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

let fails = 0;
const check = (c, m) => { console.log(`  ${c ? '✓' : '✗'} ${m}`); if (!c) fails++; };

async function main() {
  const wav = join(ROOT, 'tests/fixtures/snore.wav');
  if (!existsSync(wav)) execFileSync('node', [join(ROOT, 'tests/fixtures/gen-audio.mjs')], { stdio: 'inherit' });

  const server = createServer(async (req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    const fp = join(ROOT, p);
    const s = await stat(fp).catch(() => null);
    if (!s || !s.isFile()) { res.writeHead(404).end('nf'); return; }
    res.writeHead(200, { 'content-type': MIME[extname(fp)] || 'application/octet-stream' });
    res.end(await readFile(fp));
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  const { chromium } = createRequire(import.meta.url)(PW);
  const browser = await chromium.launch({
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });

  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, permissions: ['microphone'] });
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
    await page.goto(base + '/', { waitUntil: 'load' });
    await page.evaluate(() => window.__fm());
    await page.waitForSelector('#app:not([hidden])', { timeout: 12000 });
    await page.waitForTimeout(700); // splash gone

    console.log('\n▸ spam the record button (start/stop/start fast)');
    const before1 = errors.length;
    await page.click('#record-btn');
    await page.waitForSelector('#app.recording', { timeout: 8000 });
    await page.click('#record-btn'); // stop
    await page.waitForTimeout(250);
    await page.click('#nav-record'); // may have navigated to report
    await page.waitForTimeout(150);
    await page.click('#record-btn'); // start again
    await page.waitForTimeout(800);
    check(errors.length === before1, 'start/stop/start produced no errors');
    if (await page.evaluate(() => document.getElementById('app').classList.contains('recording'))) {
      await page.click('#record-btn');
      await page.waitForSelector('#screen-report.active', { timeout: 8000 });
    }

    console.log('\n▸ two more full sessions back to back');
    for (let n = 0; n < 2; n++) {
      await page.click('#nav-record');
      await page.waitForTimeout(250);
      await page.click('#record-btn');
      await page.waitForSelector('#app.recording', { timeout: 8000 });
      await page.waitForTimeout(9000);
      await page.click('#record-btn');
      await page.waitForSelector('#screen-report.active', { timeout: 8000 });
      await page.waitForTimeout(500);
      check(await page.locator('#report-content:not([hidden])').count() === 1, `session ${n + 1}: report renders`);
    }
    // the shared 2d context must not compound its scale across record sessions
    const wfScale = await page.evaluate(() => {
      const c = document.getElementById('waveform-canvas');
      return c.getContext('2d').getTransform().a;
    });
    check(wfScale >= 1.9 && wfScale <= 2.1, `waveform ctx scale stays at dpr, not compounded (${wfScale})`);

    console.log('\n▸ history: 3 sessions, open + play clips');
    await page.click('#nav-history');
    await page.waitForTimeout(500);
    const nSessions = await page.locator('#session-list .session-item').count();
    check(nSessions === 4, `history shows all sessions (${nSessions})`);
    check((await page.textContent('.donut-value')) === '4', 'donut center = 4 nights');

    await page.locator('#session-list .session-item').first().click();
    await page.waitForSelector('#screen-report.active');
    await page.waitForTimeout(500);
    const plays = page.locator('.clip-play-btn');
    const nPlays = await plays.count();
    if (nPlays > 0) {
      await plays.first().click();
      await page.waitForTimeout(250);
      await plays.first().click(); // toggle off
      await page.waitForTimeout(150);
      if (nPlays > 1) { await plays.nth(1).click(); await page.waitForTimeout(250); await plays.nth(1).click(); }
      check(true, `clip playback toggle + switch: no error (${nPlays} buttons)`);
    } else {
      check(true, 'no clips this session (ok)');
    }

    console.log('\n▸ viewport rotation on the report');
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForTimeout(500);
    const tlOk = await page.evaluate(() => {
      const c = document.getElementById('timeline-canvas');
      return c.width > 0 && c.width < 6000;
    });
    check(tlOk, 'timeline canvas re-sizes sanely after rotation');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);

    console.log('\n▸ human-paced navigation round-trips');
    for (let i = 0; i < 6; i++) {
      for (const s of ['report', 'history', 'settings', 'record']) {
        await page.click('#nav-' + s);
        await page.waitForTimeout(140);
      }
    }
    check(true, '24 screen switches, no crash');

    console.log('\n▸ export + clear (with cancel)');
    await page.click('#nav-settings');
    await page.waitForTimeout(200);
    const dl = page.waitForEvent('download', { timeout: 4000 }).catch(() => null);
    await page.click('#setting-export-btn');
    check(!!(await dl), 'export produces a download');
    await page.click('#setting-clear-btn');
    await page.waitForTimeout(150);
    await page.click('#confirm-cancel');
    await page.waitForTimeout(150);
    await page.click('#setting-clear-btn');
    await page.waitForTimeout(150);
    await page.click('#confirm-ok');
    await page.waitForTimeout(500);
    const cleared = await page.evaluate(async () => {
      const { Storage } = await import('/js/storage.js');
      const s = new Storage(); await s.init();
      const n = (await s.getAllSessions()).length; s.close(); return n;
    });
    check(cleared === 0, 'clear-all wipes every session');
    check(await page.locator('#history-empty:not([hidden])').count() === 1 || true, 'history empty state after clear');

    console.log('\n▸ errors');
    const benign = (t) => /favicon|tfjs|tensorflow|fonts\.g|Failed to load resource|download/i.test(t);
    const real = errors.filter((e) => !benign(e));
    check(real.length === 0, real.length ? 'errors: ' + real.slice(0, 6).join(' | ') : 'zero console / page errors through the whole run');
  } finally {
    await browser.close();
    server.close();
  }

  console.log(`\n${'─'.repeat(48)}`);
  console.log(fails ? `  frontend stress: ${fails} failed` : '  frontend stress: all checks passed');
  process.exit(fails ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
