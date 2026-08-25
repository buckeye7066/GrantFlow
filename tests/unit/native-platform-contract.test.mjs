import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import {
  assertNativePlatforms,
  collectNativePlatformProblems,
} from '../../scripts/check-native-platforms.mjs'

const temporaryRoots = []

after(() => {
  for (const root of temporaryRoots) fs.rmSync(root, { recursive: true, force: true })
})

test('the checked-in Android and iOS projects satisfy the native contract', () => {
  assert.equal(assertNativePlatforms(), true)
})

test('a clean checkout cannot pass when a native platform is only a partial shell', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grantflow-native-contract-'))
  temporaryRoots.push(root)
  fs.writeFileSync(path.join(root, 'capacitor.config.json'), JSON.stringify({
    appId: 'com.grantflow.app',
    appName: 'GrantFlow',
  }))

  const problems = collectNativePlatformProblems(root)
  assert.ok(problems.some((problem) => problem.includes('AndroidManifest.xml')))
  assert.ok(problems.some((problem) => problem.includes('App.xcodeproj')))
})
