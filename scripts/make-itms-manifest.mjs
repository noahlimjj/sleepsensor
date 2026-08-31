#!/usr/bin/env node
/*
 * make-itms-manifest.mjs — generate the itms-services manifest.plist that lets
 * an ad-hoc-signed iOS build install straight from a web link.
 *
 * Apple's over-the-air install flow is:
 *   a link  ->  itms-services://?action=download-manifest&url=<manifest.plist>
 *           ->  iOS reads the plist, downloads the software-package (.ipa),
 *               installs it if the device UDID is in the embedded ad-hoc profile.
 *
 * This writes dist/manifest.plist and prints the itms-services:// URL to paste
 * into install.html CONFIG.itmsManifestUrl (or wherever you host the button).
 *
 * Inputs come from env vars or --flags (flags win). Nothing here needs signing;
 * it only describes an .ipa that some other step produced.
 *
 *   IPA_URL / --ipa-url                (required) public https URL of the .ipa
 *   BUNDLE_ID / --bundle-id            default: app.sleepsensor.monitor
 *   BUNDLE_VERSION / --bundle-version  default: 1.0.0
 *   APP_TITLE / --title                default: SleepSensor
 *   DISPLAY_IMAGE_URL / --display-image
 *                                     default: <site>/assets/icons/icon-192.png
 *   FULL_SIZE_IMAGE_URL / --full-size-image
 *                                     default: <site>/assets/icons/icon-512.png
 *   MANIFEST_URL / --manifest-url      where THIS plist will be served from, used
 *                                     only to print the itms-services:// link
 *                                     default: <release>/download/manifest.plist
 */
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT_DIR = join(ROOT, 'dist');
const OUT = join(OUT_DIR, 'manifest.plist');

const SITE = 'https://sleepsensor.vercel.app';
const RELEASE = 'https://github.com/noahlimjj/sleepsensor/releases/latest';

// --- arg / env parsing -------------------------------------------------------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq !== -1) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      out[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    }
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const pick = (flag, env, fallback) => args[flag] ?? process.env[env] ?? fallback;

const ipaUrl = pick('ipa-url', 'IPA_URL', '');
const bundleId = pick('bundle-id', 'BUNDLE_ID', 'app.sleepsensor.monitor');
const bundleVersion = pick('bundle-version', 'BUNDLE_VERSION', '1.0.0');
const title = pick('title', 'APP_TITLE', 'SleepSensor');
const displayImage = pick('display-image', 'DISPLAY_IMAGE_URL', `${SITE}/assets/icons/icon-192.png`);
const fullSizeImage = pick('full-size-image', 'FULL_SIZE_IMAGE_URL', `${SITE}/assets/icons/icon-512.png`);
const manifestUrl = pick('manifest-url', 'MANIFEST_URL', `${RELEASE}/download/manifest.plist`);

if (!ipaUrl) {
  console.error('✖ IPA_URL (or --ipa-url) is required — the public https URL of the .ipa');
  process.exit(1);
}
for (const [name, val] of [['IPA_URL', ipaUrl], ['DISPLAY_IMAGE_URL', displayImage], ['FULL_SIZE_IMAGE_URL', fullSizeImage]]) {
  if (!/^https:\/\//.test(val)) {
    console.error(`✖ ${name} must be an https:// URL (got: ${val})`);
    process.exit(1);
  }
}

// --- plist -----------------------------------------------------------------
const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const manifest = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>items</key>
  <array>
    <dict>
      <key>assets</key>
      <array>
        <dict>
          <key>kind</key>
          <string>software-package</string>
          <key>url</key>
          <string>${esc(ipaUrl)}</string>
        </dict>
        <dict>
          <key>kind</key>
          <string>display-image</string>
          <key>url</key>
          <string>${esc(displayImage)}</string>
        </dict>
        <dict>
          <key>kind</key>
          <string>full-size-image</string>
          <key>url</key>
          <string>${esc(fullSizeImage)}</string>
        </dict>
      </array>
      <key>metadata</key>
      <dict>
        <key>bundle-identifier</key>
        <string>${esc(bundleId)}</string>
        <key>bundle-version</key>
        <string>${esc(bundleVersion)}</string>
        <key>kind</key>
        <string>software</string>
        <key>title</key>
        <string>${esc(title)}</string>
      </dict>
    </dict>
  </array>
</dict>
</plist>
`;

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT, manifest);

  const itmsUrl = `itms-services://?action=download-manifest&url=${encodeURIComponent(manifestUrl)}`;

  console.log(`  + dist/manifest.plist`);
  console.log(`    bundle-identifier : ${bundleId}`);
  console.log(`    bundle-version    : ${bundleVersion}`);
  console.log(`    software-package  : ${ipaUrl}`);
  console.log(`\n  install link (set install.html CONFIG.itmsManifestUrl to the manifest URL):`);
  console.log(`    manifest URL : ${manifestUrl}`);
  console.log(`    itms-services: ${itmsUrl}`);

  if (process.env.GITHUB_OUTPUT) {
    await writeFile(process.env.GITHUB_OUTPUT, `itms_url=${itmsUrl}\nmanifest_url=${manifestUrl}\n`, { flag: 'a' });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
