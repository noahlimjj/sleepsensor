// Dev helper: phone-size screenshots of the Night clips panel on the sample night.
//   node tests/shot-night-clips.mjs [outDir]
import { createServer } from 'http';
import { readFile, stat } from 'fs/promises';
import { join, extname } from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = process.argv[2] || '/tmp';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.wav': 'audio/wav', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = createServer(async (req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  if (p === '/js/firebase-config.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end('export const FIREBASE_CONFIG={};export const FIREBASE_SDK_VERSION="10.13.0";export const AUTH_METHODS={guest:true};export function firebaseConfigured(){return false;}'); }
  const fp = join(ROOT, p); const s = await stat(fp).catch(() => null);
  if (!s || !s.isFile()) { res.writeHead(404).end('nf'); return; }
  res.writeHead(200, { 'content-type': MIME[extname(fp)] || 'application/octet-stream' }); res.end(await readFile(fp));
});
await new Promise((r) => server.listen(0, r));
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PATH || 'playwright');
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto(`http://localhost:${server.address().port}/`);
await page.waitForTimeout(1500);
await page.click('#nav-settings'); await page.click('#setting-sample-btn'); await page.waitForTimeout(3000);
await page.click('#nav-report'); await page.waitForTimeout(1500); await page.locator('#night-clips-section').scrollIntoViewIfNeeded();
const sec = page.locator('#night-clips-section');
await sec.screenshot({ path: `${OUT}/nc-collapsed.png` });
const rows = await page.locator('.nc-row').count();
await page.locator('.nc-play').first().click(); await page.waitForTimeout(800);
const playing = await page.evaluate(() => !!document.querySelector('.nc-play svg rect'));
const more = page.locator('[data-toggle]').first();
if (await more.count()) { await more.click(); await page.waitForTimeout(300); }
await page.locator('input[data-select]').first().check(); await page.waitForTimeout(200);
await sec.screenshot({ path: `${OUT}/nc-expanded.png` });
console.log(JSON.stringify({ rows, rowsExpanded: await page.locator('.nc-row').count(), playing, shareSel: await page.textContent('[data-action="share-selected"]'), errors }));
await browser.close(); server.close();
