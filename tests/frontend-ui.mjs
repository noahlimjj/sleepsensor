// Frontend UI smoke test: drives the real app in Chromium with a fake mic,
// records a session, opens the report + history + settings, and asserts the
// screens render with no console/page errors and the new features are wired.
import { createServer } from 'http';
import { readFile, stat } from 'fs/promises';
import { join, extname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PW = '/Users/User/.nvm/versions/node/v22.18.0/lib/node_modules/playwright/index.js';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.wav': 'audio/wav', '.svg': 'image/svg+xml', '.png': 'image/png' };

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
    res.writeHead(200, { 'content-type': MIME[extname(fp)] || 'application/octet-stream', 'service-worker-allowed': '/' });
    res.end(await readFile(fp));
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;

  const { chromium } = createRequire(import.meta.url)(PW);
  const browser = await chromium.launch({
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });

  try {
    const ctx = await browser.newContext({ permissions: ['microphone'] });
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));

    // fake mic: looped real-snore WAV through a MediaStreamDestination
    await page.addInitScript(() => {
      window.__installFakeMic = async () => {
        const probe = new AudioContext();
        const buf = await probe.decodeAudioData(await (await fetch('/tests/fixtures/snore.wav')).arrayBuffer());
        navigator.mediaDevices.getUserMedia = async () => {
          const ac = new AudioContext();
          const d = ac.createMediaStreamDestination();
          const s = ac.createBufferSource();
          s.buffer = buf; s.loop = true; s.connect(d); s.start();
          if (ac.state === 'suspended') await ac.resume();
          return d.stream;
        };
      };
    });

    console.log('\n▸ boot');
    await page.goto(base + '/', { waitUntil: 'load' });
    await page.evaluate(() => window.__installFakeMic());
    await page.waitForSelector('#app:not([hidden])', { timeout: 12000 });
    check(true, 'app boots past splash');
    check(await page.locator('#screen-record.active').count() === 1, 'record screen active by default');

    console.log('\n▸ settings — sensitivity label');
    await page.click('#nav-settings');
    await page.waitForTimeout(200);
    const desc = await page.textContent('#setting-sensitivity-desc');
    const detail = await page.textContent('#setting-sensitivity-detail');
    check(!!desc && desc !== 'undefined' && /Low|Medium|High|Maximum/.test(desc), `sensitivity label is a word ("${desc}")`);
    check(!!detail && detail !== 'undefined' && detail.length > 10, `sensitivity detail is a sentence`);
    // move the slider
    await page.$eval('#setting-sensitivity', (el) => { el.value = 90; el.dispatchEvent(new Event('input')); });
    await page.waitForTimeout(100);
    check((await page.textContent('#setting-sensitivity-desc')) === 'Maximum', 'slider to 90 -> "Maximum"');
    await page.$eval('#setting-sensitivity', (el) => { el.value = 50; el.dispatchEvent(new Event('input')); });

    console.log('\n▸ record a session');
    await page.click('#nav-record');
    await page.click('#record-btn');
    await page.waitForSelector('#app.recording', { timeout: 8000 });
    check(true, 'recording state entered');
    const guidance = await page.textContent('#background-guidance');
    check(guidance && guidance !== '[object Object]' && guidance.length > 20, `background guidance is text, not [object Object]`);
    await page.waitForTimeout(1500);
    const db = await page.textContent('#db-value');
    check(!!db && db !== '--', `dB meter updates ("${db}")`);
    await page.waitForTimeout(15000);
    const snoreCount = parseInt(await page.textContent('#stat-snoring-count'), 10);
    check(snoreCount >= 1, `snoring counter incremented (${snoreCount})`);

    await page.click('#record-btn'); // stop
    await page.waitForSelector('#screen-report.active', { timeout: 8000 });
    check(true, 'stops and navigates to the report');

    console.log('\n▸ report screen');
    await page.waitForTimeout(500);
    check(await page.locator('#report-content:not([hidden])').count() === 1, 'report content visible');
    const sleepTime = await page.textContent('#report-sleep-time');
    check(!!sleepTime && sleepTime !== '--', `total sleep filled ("${sleepTime}")`);
    const tlCanvas = await page.$eval('#timeline-canvas', (c) => ({ w: c.width, h: c.height }));
    check(tlCanvas.w > 0 && tlCanvas.h > 0, `timeline canvas sized (${tlCanvas.w}x${tlCanvas.h})`);
    const sevRows = await page.locator('.severity-bar-row').count();
    check(sevRows === 3, 'severity breakdown rendered (3 rows)');
    const clipCards = await page.locator('#clips-list .clip-card').count();
    const hlCards = await page.locator('#highlights-carousel .highlight-card').count();
    check(clipCards + hlCards >= 1, `clips/highlights rendered (${clipCards} clips, ${hlCards} highlights)`);

    // play a clip if present
    const anyPlay = page.locator('.clip-play-btn').first();
    if (await anyPlay.count()) {
      await anyPlay.click();
      await page.waitForTimeout(300);
      check(true, 'clip play button clickable without error');
      await anyPlay.click(); // stop
    }

    console.log('\n▸ history screen');
    await page.click('#nav-history');
    await page.waitForTimeout(400);
    const trend = await page.$eval('#trend-chart', (c) => ({ w: c.width, h: c.height }));
    check(trend.w > 0 && trend.h > 0, `trend chart sized (${trend.w}x${trend.h})`);
    const donut = await page.$eval('#donut-chart', (c) => ({ w: c.width, h: c.height }));
    check(donut.w > 0, `donut chart sized (${donut.w}x${donut.h})`);
    check((await page.locator('#session-list .session-item').count()) >= 1, 'session list has the recorded night');
    check((await page.textContent('.donut-value')) === '1', 'donut center shows 1 night');

    // open the session from history
    await page.locator('#session-list .session-item').first().click();
    await page.waitForSelector('#screen-report.active');
    await page.waitForTimeout(400);
    check(await page.locator('#report-content:not([hidden])').count() === 1, 'history -> report opens content');

    console.log('\n▸ errors');
    const benign = (t) => /favicon|tensorflow|tfjs|fonts\.g|Failed to load resource/i.test(t);
    const real = errors.filter((e) => !benign(e));
    check(real.length === 0, real.length ? 'console errors: ' + real.join(' | ') : 'no console / page errors across the whole flow');

    await page.screenshot({ path: join(ROOT, 'tests/fixtures/ui-report.png') }).catch(() => {});
  } finally {
    await browser.close();
    server.close();
  }

  console.log(`\n${'─'.repeat(48)}`);
  console.log(fails ? `  frontend UI: ${fails} check(s) failed` : '  frontend UI: all checks passed');
  process.exit(fails ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
