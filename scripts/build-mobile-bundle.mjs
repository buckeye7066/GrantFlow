#!/usr/bin/env node
// Publish the OTA web-bundle feed for the native (Capacitor) app.
//
// After `vite build` produces dist/, this zips the built assets into
//   dist/mobile/bundle-<version>.zip
// and writes
//   dist/mobile/latest.json
//     -> { version, url, sha256, minNativeVersion, notes, builtAt }
// pointing at the zip with an absolute production URL. Vercel serves dist/
// statically (filesystem wins over the SPA rewrite), so merging + deploying
// makes the feed live at https://axiombiolabs.org/mobile/latest.json.
//
// The in-app "Check for Updates" control (src/lib/mobileUpdater.js) consumes
// this feed via @capgo/capacitor-updater. Version = package.json version.
//
// Runs automatically as npm postbuild; also available as
//   npm run build:mobile-bundle   (build + this script)

import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)
const AdmZip = require('adm-zip')

// Project root. argv[2] is a test seam ONLY (tests/unit/mobileBundleManifest.test.js
// points the real script at a temp tree so the published manifest can be
// verified against the real zip bytes). npm postbuild passes nothing.
const root = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distDir = path.join(root, 'dist')
const mobileDir = path.join(distDir, 'mobile')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = pkg.version
// The bundle is written INTO dist/mobile/ beside latest.json, so it is always
// served from the same origin as the manifest. Hardcoding an origin here broke
// exactly that invariant: the default said `axiombiolabs.org`, but that apex is
// a DIFFERENT Vercel project (the static publish site) while GrantFlow serves at
// `app.axiombiolabs.org`. Measured live 2026-08-19: the manifest published a
// bundle URL that returned 200 with `text/html` — the other project's SPA
// fallback — instead of the 2.1 MB zip sitting next to it. The checksum gate
// would have refused to install that page, so the update simply died for every
// user. Prefer Vercel's own production domain (self-correcting if the domain
// moves again), then an explicit override, and only then the constant.
const baseUrl =
  process.env.MOBILE_UPDATE_BASE_URL
  || (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : null)
  || 'https://app.axiombiolabs.org'
// Trailing slashes would produce `https://host//mobile/...` in the manifest.
const normalizedBaseUrl = baseUrl.replace(/\/+$/, '')

if (!fs.existsSync(path.join(distDir, 'index.html'))) {
  console.error('[mobile-bundle] dist/index.html not found — run the web build first (npm run build).')
  process.exit(1)
}

fs.rmSync(mobileDir, { recursive: true, force: true })
fs.mkdirSync(mobileDir, { recursive: true })

const zip = new AdmZip()
for (const entry of fs.readdirSync(distDir, { withFileTypes: true })) {
  if (entry.name === 'mobile') continue // never nest the feed inside its own bundle
  const full = path.join(distDir, entry.name)
  if (entry.isDirectory()) zip.addLocalFolder(full, entry.name)
  else zip.addLocalFile(full)
}

const zipName = `bundle-${version}.zip`
const zipPath = path.join(mobileDir, zipName)
zip.writeZip(zipPath)

// Integrity: sha256 of the zip BYTES exactly as served. @capgo/capacitor-updater
// hashes the downloaded zip with SHA-256 (Android CryptoCipher.calcChecksum ->
// MessageDigest "SHA-256"; iOS CryptoCipher.calcChecksum -> CryptoKit SHA256),
// lowercase hex, and throws when the value passed as download({ checksum })
// does not match — so publishing this field makes the update verifiable and
// the client fails closed on a mismatch. Never rename/reformat this without
// re-reading those two native files: the comparison is exact-string.
const sha256 = createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex')

// Native floor: the lowest native app version (Android versionName /
// iOS CFBundleShortVersionString) this WEB bundle is safe to run on. OTA
// replaces the web bundle only — it can never deliver new native code or a new
// Capacitor plugin. When a web bundle starts requiring native code that older
// APKs/IPAs do not carry, bump `mobile.minNativeVersion` in package.json (and
// the native versionName that ships it) so the app tells the user "a new app
// version is required" instead of silently applying a bundle that cannot work.
const minNativeVersion = process.env.MOBILE_MIN_NATIVE_VERSION || pkg.mobile?.minNativeVersion || ''

const manifest = {
  version,
  url: `${normalizedBaseUrl}/mobile/${zipName}`,
  sha256,
  ...(minNativeVersion ? { minNativeVersion } : {}),
  notes: `GrantFlow web bundle v${version}`,
  builtAt: new Date().toISOString(),
}
fs.writeFileSync(path.join(mobileDir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

const zipBytes = fs.statSync(zipPath).size
console.log(
  `[mobile-bundle] wrote dist/mobile/${zipName} (${(zipBytes / 1024 / 1024).toFixed(1)} MB, sha256 ${sha256}) ` +
    `and dist/mobile/latest.json -> ${manifest.url}` +
    (minNativeVersion ? ` (min native ${minNativeVersion})` : ''),
)
