// Frontend edge cases: empty state, crash recovery, mobile viewport, clear data.
import { createServer } from 'http';
import { readFile, stat } from 'fs/promises';
import { join, extname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PW = '/Users/User/.nvm/versions/node/v22.18.0/lib/node_modules/playwright/index.js';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.wav': 'audio/wav' };

let fails = 0;
const check = (c, m) => { console.log(`  ${c ? '✓' : '✗'} ${m}`); if (!c) fails++; };

async function main() {
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
  const browser = await chromium.launch();

  try {
    // ---- 1. fresh install: empty states, mobile viewport ----
    console.log('\n▸ empty state (fresh, iPhone viewport)');
    let ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 });
    let page = await ctx.newPage();
    const errs = [];
    page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
    page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
    await page.goto(base + '/', { waitUntil: 'load' });
    await page.waitForSelector('#app:not([hidden])', { timeout: 12000 });

    await page.click('#nav-report');
    await page.waitForTimeout(200);
    check(await page.locator('#report-empty:not([hidden])').count() === 1, 'report shows empty state with no data');

    await page.click('#nav-history');
    await page.waitForTimeout(300);
    check(await page.locator('#history-empty:not([hidden])').count() === 1, 'history shows empty state');
    const trendText = await page.evaluate(() => {
      const c = document.getElementById('trend-chart');
      return c.width > 0; // sized even with no data
    });
    check(trendText, 'trend chart still sizes with no sessions');
    check((await page.textContent('.donut-value')) === '0', 'donut center shows 0 nights');

    // body must not scroll horizontally on a phone
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    check(overflow, 'no horizontal overflow on a 390px viewport');

    const benign = (t) => /favicon|tfjs|tensorflow|fonts\.g|Failed to load resource/i.test(t);
    check(errs.filter((e) => !benign(e)).length === 0, `no errors on the empty app${errs.length ? ': ' + errs.join(' | ') : ''}`);
    await ctx.close();

    // ---- 2. crash recovery: seed a stale open session, reload ----
    console.log('\n▸ crash recovery');
    ctx = await browser.newContext();
    page = await ctx.newPage();
    const rerrs = [];
    page.on('pageerror', (e) => rerrs.push(e.message));
    await page.goto(base + '/', { waitUntil: 'load' });
    await page.waitForSelector('#app:not([hidden])', { timeout: 12000 });

    // write an abandoned session directly into IndexedDB
    await page.evaluate(async () => {
      const { Storage } = await import('/js/storage.js');
      const s = new Storage();
      await s.init();
      const now = Date.now();
      const sess = await s.createSession({ startTime: now - 6 * 3600e3 });
      await s.updateSession(sess.id, {
        lastCheckpoint: now - 5 * 3600e3,
        snoringDuration: 1200,
        bruxismDuration: 60,
      });
      s.close();
    });

    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('#app:not([hidden])', { timeout: 12000 });
    await page.waitForTimeout(700);
    const bannerVisible = await page.locator('#status-banner:not([hidden])').count();
    const bannerText = await page.textContent('#status-banner-text').catch(() => '');
    check(bannerVisible === 1 && /ended early|saved/i.test(bannerText), `recovery banner shown ("${bannerText}")`);

    const recovered = await page.evaluate(async () => {
      const { Storage } = await import('/js/storage.js');
      const s = new Storage();
      await s.init();
      const all = await s.getAllSessions();
      s.close();
      return all.map((x) => ({ end: x.endTime, rec: x.recovered }));
    });
    check(recovered.every((r) => r.end != null), 'the abandoned session was finalised (endTime set)');
    check(recovered.some((r) => r.rec === true), 'it is flagged recovered:true');

    // the recovered session shows in history + report with a note
    await page.click('#nav-history');
    await page.waitForTimeout(300);
    check((await page.locator('#session-list .session-item').count()) >= 1, 'recovered session appears in history');
    await page.locator('#session-list .session-item').first().click();
    await page.waitForSelector('#screen-report.active');
    await page.waitForTimeout(300);
    check(/unexpectedly/i.test(await page.textContent('#report-date')), 'report shows the "ended unexpectedly" note');

    check(rerrs.length === 0, `no page errors during recovery${rerrs.length ? ': ' + rerrs.join(' | ') : ''}`);

    // ---- 3. clear all data ----
    console.log('\n▸ clear all data');
    await page.click('#nav-settings');
    await page.waitForTimeout(150);
    await page.click('#setting-clear-btn');
    await page.waitForTimeout(150);
    await page.click('#confirm-ok');
    await page.waitForTimeout(400);
    const afterClear = await page.evaluate(async () => {
      const { Storage } = await import('/js/storage.js');
      const s = new Storage();
      await s.init();
      const n = (await s.getAllSessions()).length;
      s.close();
      return n;
    });
    check(afterClear === 0, 'clear all data empties every session');
    await ctx.close();
  } finally {
    await browser.close();
    server.close();
  }

  console.log(`\n${'─'.repeat(48)}`);
  console.log(fails ? `  frontend edge: ${fails} failed` : '  frontend edge: all checks passed');
  process.exit(fails ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
