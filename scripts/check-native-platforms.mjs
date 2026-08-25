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
  'ios/App/App/Info.plist',
  'ios/App/CapApp-SPM/Package.swift',
]

function read(root, relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
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
  ]

  for (const [relativePath, expected, label] of checks) {
    const absolutePath = path.join(root, relativePath)
    if (!fs.existsSync(absolutePath)) {
      problems.push(`missing or empty: ${relativePath}`)
      continue
    }
    if (!read(root, relativePath).includes(expected)) {
      problems.push(`${label} does not match capacitor.config.json (${expected})`)
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
