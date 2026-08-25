#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const REQUIRED_FILES = [
  'capacitor.config.json',
  'android/app/build.gradle',
  'android/app/src/main/AndroidManifest.xml',
  'android/app/src/main/java/com/grantflow/app/MainActivity.java',
  'android/gradle/wrapper/gradle-wrapper.jar',
  'android/gradle/wrapper/gradle-wrapper.properties',
  'ios/App/App.xcodeproj/project.pbxproj',
  'ios/App/App/AppDelegate.swift',
  'ios/App/App/SceneDelegate.swift',
  'ios/App/App/Base.lproj/Main.storyboard',
  'ios/App/App/Info.plist',
  'ios/App/CapApp-SPM/Package.swift',
]

function read(root, relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function plistStringValue(source, key) {
  const match = source.match(new RegExp(`<key>\\s*${escapeRegExp(key)}\\s*</key>\\s*<string>\\s*([^<]+?)\\s*</string>`))
  return match?.[1]?.trim() || null
}

function storyboardInitialController(source) {
  const initialId = source.match(/<document\b[^>]*\binitialViewController="([^"]+)"/)?.[1]
  if (!initialId) return null
  const controller = source.match(new RegExp(`<viewController\\b(?=[^>]*\\bid="${escapeRegExp(initialId)}")(?=[^>]*\\bcustomClass="([^"]+)")[^>]*>`))
  return controller ? { id: initialId, customClass: controller[1] } : { id: initialId, customClass: null }
}

export function collectNativePlatformProblems(root = DEFAULT_ROOT) {
  const problems = []

  for (const relativePath of REQUIRED_FILES) {
    const absolutePath = path.join(root, relativePath)
    if (!fs.existsSync(absolutePath) || fs.statSync(absolutePath).size === 0) {
      problems.push(`missing or empty: ${relativePath}`)
    }
  }

  const capacitorPath = path.join(root, 'capacitor.config.json')
  if (!fs.existsSync(capacitorPath)) return problems

  let config
  try {
    config = JSON.parse(read(root, 'capacitor.config.json'))
  } catch (error) {
    problems.push(`capacitor.config.json is invalid JSON: ${error.message}`)
    return problems
  }

  const appId = String(config.appId || '').trim()
  const appName = String(config.appName || '').trim()
  if (!appId) problems.push('capacitor appId is empty')
  if (!appName) problems.push('capacitor appName is empty')

  const checks = [
    ['android/app/build.gradle', `applicationId "${appId}"`, 'Android applicationId'],
    ['android/app/src/main/java/com/grantflow/app/MainActivity.java', `package ${appId};`, 'Android Java package'],
    ['android/app/src/main/res/values/strings.xml', `<string name="app_name">${appName}</string>`, 'Android app name'],
    ['ios/App/App.xcodeproj/project.pbxproj', `PRODUCT_BUNDLE_IDENTIFIER = ${appId};`, 'iOS bundle identifier'],
    ['ios/App/App/Info.plist', `<string>${appName}</string>`, 'iOS display name'],
    ['ios/App/App.xcodeproj/project.pbxproj', 'SceneDelegate.swift in Sources', 'iOS SceneDelegate source phase'],
    ['ios/App/App/AppDelegate.swift', 'configurationForConnecting', 'iOS scene configuration hook'],
    ['ios/App/App/SceneDelegate.swift', 'CAPBridgeViewController()', 'iOS Capacitor scene bridge'],
    ['ios/App/App/SceneDelegate.swift', 'if window == nil', 'iOS storyboard window preservation'],
    ['ios/App/App/SceneDelegate.swift', 'SceneDelegateProxy.shared.scene', 'iOS scene callback proxy'],
    ['ios/App/App/Base.lproj/Main.storyboard', 'customClass="CAPBridgeViewController"', 'iOS storyboard bridge root'],
    ['ios/App/App/Info.plist', '<key>UIApplicationSceneManifest</key>', 'iOS scene manifest'],
    ['ios/App/App/Info.plist', '$(PRODUCT_MODULE_NAME).SceneDelegate', 'iOS scene delegate manifest entry'],
  ]

  for (const [relativePath, expected, label] of checks) {
    const absolutePath = path.join(root, relativePath)
    if (!fs.existsSync(absolutePath)) {
      problems.push(`missing or empty: ${relativePath}`)
      continue
    }
    if (!read(root, relativePath).includes(expected)) {
      problems.push(`${label} is missing required contract (${expected})`)
    }
  }

  const packagePath = path.join(root, 'ios/App/CapApp-SPM/Package.swift')
  if (fs.existsSync(packagePath)) {
    const swiftPackage = read(root, 'ios/App/CapApp-SPM/Package.swift')
    if (!/capacitor-swift-pm\.git",\s*exact:\s*"8\.5\.0"/.test(swiftPackage)) {
      problems.push('iOS Capacitor Swift package must be pinned to 8.5.0 for SceneDelegateProxy')
    }
  }

  const plistPath = path.join(root, 'ios/App/App/Info.plist')
  const storyboardPath = path.join(root, 'ios/App/App/Base.lproj/Main.storyboard')
  if (fs.existsSync(plistPath)) {
    const sceneStoryboard = plistStringValue(read(root, 'ios/App/App/Info.plist'), 'UISceneStoryboardFile')
    if (sceneStoryboard !== 'Main') {
      problems.push('iOS scene storyboard must resolve UISceneStoryboardFile to Main')
    }
  }
  if (fs.existsSync(storyboardPath)) {
    const initialController = storyboardInitialController(read(root, 'ios/App/App/Base.lproj/Main.storyboard'))
    if (!initialController || initialController.customClass !== 'CAPBridgeViewController') {
      problems.push('iOS Main storyboard initialViewController must resolve to CAPBridgeViewController')
    }
  }

  return [...new Set(problems)]
}

export function assertNativePlatforms(root = DEFAULT_ROOT) {
  const problems = collectNativePlatformProblems(root)
  if (problems.length > 0) {
    throw new Error(`native platform contract failed:\n- ${problems.join('\n- ')}`)
  }
  return true
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assertNativePlatforms()
    console.log('[native-platforms] Android and iOS projects are complete and match Capacitor identity')
  } catch (error) {
    console.error(`[native-platforms] ${error.message}`)
    process.exitCode = 1
  }
}
