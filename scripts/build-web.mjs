#!/usr/bin/env node
/*
 * build-web.mjs — assemble the static web app into www/ for Capacitor.
 *
 * The web app has no bundler: it's plain HTML/CSS/ES-modules served from the
 * repo root. Capacitor needs a single self-contained folder (`webDir`), so this
 * copies just the runtime files — no tests, training data, docs or node_modules.
 *
 * Vercel keeps serving from the repo root; this only feeds the native builds.
 */
import { rm, mkdir, cp, writeFile, stat } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'www');

// files / dirs that make up the running app
const INCLUDE = ['index.html', 'manifest.json', 'sw.js', 'js', 'css', 'assets'];

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  for (const entry of INCLUDE) {
    const src = join(ROOT, entry);
    if (!(await exists(src))) {
      console.warn(`  ! skip ${entry} (not found)`);
      continue;
    }
    await cp(src, join(OUT, entry), { recursive: true });
    console.log(`  + ${entry}`);
  }

  // Capacitor serves the webDir from the bundle root (capacitor://localhost/ on
  // iOS, https://localhost/ on Android), so the app's absolute "/js/…" URLs
  // resolve unchanged — no path rewriting needed.

  // A tiny marker so the native build can show which commit it came from.
  const rev = process.env.GITHUB_SHA || process.env.VERCEL_GIT_COMMIT_SHA || 'dev';
  await writeFile(join(OUT, 'build-info.json'), JSON.stringify({ rev, builtAt: new Date().toISOString() }, null, 2));

  console.log(`\n  www/ ready (${OUT})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
