# SleepSensor — over-the-air iOS install (ad-hoc / itms-services)

The "tap a link on a web page and the app installs straight to the home screen"
path, like the xiaoice / neuralfin installers. On iOS this is **ad-hoc
distribution through an `itms-services://` manifest**. It is wired up here but
switched **off** until you add signing material — `install.html`
`CONFIG.itmsManifestUrl` is `''`, the workflow job skips, the existing unsigned
build is untouched.

## What it is and its limits

- A signed `.ipa` is uploaded somewhere public. A `manifest.plist` points at it.
  A link of the form
  `itms-services://?action=download-manifest&url=<manifest URL>` makes iOS
  download and install it with no App Store and no desktop.
- Needs the **Apple Developer Program** ($99/year).
- The ad-hoc provisioning profile **embeds a fixed list of device UDIDs** — max
  **100 per device type per membership year** (100 iPhones, separately 100 iPads,
  etc.). Counts reset once a year at renewal and registered devices can't be
  removed mid-year without burning a slot.
- **Adding a tester = re-registering their UDID + rebuilding the `.ipa`.** There
  is no "just send them the link"; the link only works for devices already in the
  profile.
- The **profile and certificate expire yearly** — the app stops launching and
  you must rebuild with a fresh profile.
- Apple's terms intend ad-hoc for **your own testers**, not open public
  distribution. Publishing the link publicly is a grey area and Apple can revoke
  the certificate if abused. Be honest with yourself about scale here — past ~100
  people, use TestFlight.

## "Super signature" services (超级签) — context only

Chinese "超级签 / 超级签名" (super-signature) vendors automate exactly this at
scale: they pool **many** $99 individual developer accounts, spreading testers
across them ~100 at a time, and capture each visitor's UDID automatically by
serving a `.mobileconfig` configuration profile before the install. That's how a
public "tap to install" link can serve thousands of users without TestFlight.

Caveats: you're trusting a third party with a signing identity; Apple actively
bans the pooled accounts, so installs break in waves and vendors rotate certs to
keep up; pricing is per-device-per-year; and it is squarely against Apple's
developer terms. Mentioned so you recognise what those installers are doing — not
a recommendation, and pick no vendor blind.

## Switching it on here

1. **Enrol** at <https://developer.apple.com/programs/> ($99/yr, ~24–48 h to
   activate).
2. **App ID** — App Store Connect / Certificates, Identifiers & Profiles →
   Identifiers → new App ID, explicit bundle ID `app.sleepsensor.monitor`
   (must match `capacitor.config.json`).
3. **Register tester UDIDs** — Identifiers & Profiles → Devices. A tester finds
   their UDID by:
   - plugging into a Mac → Finder → click the device → click under the name
     until the UDID row shows → right-click → Copy; or Xcode → Window → Devices
     and Simulators; or
   - a UDID web service (e.g. get.udid.io style sites) that installs a
     `.mobileconfig` and shows the UDID — quickest for remote testers.
   iOS Settings alone does **not** show the full UDID.
4. **Distribution certificate** — Certificates → new → *Apple Distribution*.
   Create it via a CSR from Keychain Access (Certificate Assistant → Request a
   Certificate from a CA), download the `.cer`, double-click to import, then in
   Keychain Access right-click the key → **Export** as `.p12` and set a password.
5. **Ad Hoc provisioning profile** — Profiles → new → Distribution → **Ad Hoc** →
   pick the App ID → pick the Distribution cert → tick the tester devices →
   download the `.mobileprovision`.
6. **Base64 the two files** (macOS):
   ```
   base64 -i dist.p12 | pbcopy            # -> IOS_DIST_CERT_P12_BASE64
   base64 -i SleepSensor_AdHoc.mobileprovision | pbcopy   # -> IOS_ADHOC_PROFILE_BASE64
   ```
7. **Add repo secrets** — GitHub → Settings → Secrets and variables → Actions →
   *Secrets*:
   | Secret | Value |
   | --- | --- |
   | `IOS_DIST_CERT_P12_BASE64` | base64 of the `.p12` |
   | `IOS_DIST_CERT_PASSWORD` | the `.p12` export password |
   | `IOS_ADHOC_PROFILE_BASE64` | base64 of the `.mobileprovision` |
   | `IOS_TEAM_ID` | 10-char Team ID (top-right of the developer portal) |
8. **Add the gate variable** — same page, *Variables* tab: `IOS_SIGNING_ENABLED`
   = `true`. Until this is set the `release-ios-signed.yml` job skips and runs
   stay green.
9. **Run it** — push a `v*` tag (e.g. `v1.0.1`) or run **Release iOS (signed
   ad-hoc)** from the Actions tab. It builds, signs, exports
   `SleepSensor-adhoc.ipa`, generates `manifest.plist`, and attaches both to the
   GitHub Release. The workflow log prints the `itms-services://` URL.
10. **Point the page at it** — set `install.html` `CONFIG.itmsManifestUrl` to
    `https://github.com/noahlimjj/sleepsensor/releases/latest/download/manifest.plist`
    and deploy. The iPhone "Install now" card appears; the button installs the
    app. Testers still open Settings → General → VPN & Device Management once to
    trust the distribution certificate.

To add a tester later: register their UDID (step 3), regenerate the profile
(step 5), refresh `IOS_ADHOC_PROFILE_BASE64`, re-run the workflow.

## The TestFlight alternative

Same paid account, different distribution:

- Upload a build to App Store Connect → TestFlight.
- **Up to 10,000 external testers** via a **public link** — no UDIDs, no
  rebuild-per-tester.
- First external build needs a **Beta App Review** (~1 day, usually once).
- Builds **expire after 90 days**; testers get the TestFlight app, not a bare
  home-screen icon (a minor UX difference).

Prefer TestFlight when: more than ~100 testers, testers you can't collect UDIDs
from, or you want a stable public link. Prefer ad-hoc / itms-services when: a
handful of known devices, no review latency, and you want the install to look
exactly like a normal app with no TestFlight container.
