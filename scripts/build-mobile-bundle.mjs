#!/usr/bin/env node
// Publish the OTA web-bundle feed for the native (Capacitor) app.
//
// After `vite build` produces dist/, this zips the built assets into
//   dist/mobile/bundle-<version>.zip
// and writes
//   dist/mobile/latest.json  ->  { version, url, notes, builtAt }
// pointing at the zip with an absolute production URL. Vercel serves dist/
// statically (filesystem wins over the SPA rewrite), so merging + deploying
// makes the feed live at https://axiombiolabs.org/mobile/latest.json.
//
// The in-app "Check for Updates" control (src/lib/mobileUpdater.js) consumes
// this feed via @capgo/capacitor-updater. Version = package.json version.
//
// Runs automatically as npm postbuild; also available as
//   npm run build:mobile-bundle   (build + this script)

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)
const AdmZip = require('adm-zip')

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distDir = path.join(root, 'dist')
const mobileDir = path.join(distDir, 'mobile')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = pkg.version
const baseUrl = process.env.MOBILE_UPDATE_BASE_URL || 'https://axiombiolabs.org'

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
zip.writeZip(path.join(mobileDir, zipName))

const manifest = {
  version,
  url: `${baseUrl}/mobile/${zipName}`,
  notes: `GrantFlow web bundle v${version}`,
  builtAt: new Date().toISOString(),
}
fs.writeFileSync(path.join(mobileDir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

const zipBytes = fs.statSync(path.join(mobileDir, zipName)).size
console.log(`[mobile-bundle] wrote dist/mobile/${zipName} (${(zipBytes / 1024 / 1024).toFixed(1)} MB) and dist/mobile/latest.json -> ${manifest.url}`)
