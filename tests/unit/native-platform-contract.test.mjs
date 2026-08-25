import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  assertNativePlatforms,
  collectNativePlatformProblems,
} from '../../scripts/check-native-platforms.mjs'

const temporaryRoots = []
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

after(() => {
  for (const root of temporaryRoots) fs.rmSync(root, { recursive: true, force: true })
})

test('the checked-in Android and iOS projects satisfy the native contract', () => {
  assert.equal(assertNativePlatforms(), true)
})

test('the iOS scene delegate is checked in and wired into the executable target', () => {
  const sceneDelegate = fs.readFileSync(
    path.join(projectRoot, 'ios/App/App/SceneDelegate.swift'),
    'utf8',
  )
  const appDelegate = fs.readFileSync(
    path.join(projectRoot, 'ios/App/App/AppDelegate.swift'),
    'utf8',
  )
  const infoPlist = fs.readFileSync(path.join(projectRoot, 'ios/App/App/Info.plist'), 'utf8')
  const xcodeProject = fs.readFileSync(
    path.join(projectRoot, 'ios/App/App.xcodeproj/project.pbxproj'),
    'utf8',
  )

  assert.match(sceneDelegate, /class SceneDelegate: UIResponder, UIWindowSceneDelegate/)
  assert.match(sceneDelegate, /CAPBridgeViewController\(\)/)
  assert.match(sceneDelegate, /SceneDelegateProxy\.shared\.scene/)
  assert.match(appDelegate, /configurationForConnecting/)
  assert.match(infoPlist, /UIApplicationSceneManifest/)
  assert.match(infoPlist, /\$\(PRODUCT_MODULE_NAME\)\.SceneDelegate/)
  assert.match(xcodeProject, /SceneDelegate\.swift in Sources/)
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
