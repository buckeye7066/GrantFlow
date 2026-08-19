# Mobile OTA updates — the shared pattern

How the native GrantFlow app learns that a new version exists, tells the user,
and installs it. Two sibling apps copy this pattern, so the contracts below are
the part to keep; the React specifics are not.

## The chain, end to end

```
merge to main
  -> Vercel builds from main (npm run build)
  -> npm postbuild runs scripts/build-mobile-bundle.mjs
       zips dist/ -> dist/mobile/bundle-<version>.zip
       writes dist/mobile/latest.json
  -> Vercel serves dist/ statically (filesystem beats the SPA rewrite)
  -> https://axiombiolabs.org/mobile/latest.json is the live feed
  -> the app checks that feed on LAUNCH and on every RESUME
  -> newer? local notification + in-app prompt
  -> user taps Install
  -> @capgo/capacitor-updater downloads the zip, VERIFIES its sha256, applies it
```

## The manifest contract

`dist/mobile/latest.json`:

```json
{
  "version": "1.0.2",
  "url": "https://axiombiolabs.org/mobile/bundle-1.0.2.zip",
  "sha256": "<64 lowercase hex chars — SHA-256 of the zip bytes as served>",
  "minNativeVersion": "1.1",
  "notes": "GrantFlow web bundle v1.0.2",
  "builtAt": "2026-08-19T00:00:00.000Z"
}
```

`minNativeVersion` is optional and comes from `package.json` -> `mobile.minNativeVersion`
(override with the `MOBILE_MIN_NATIVE_VERSION` env var). It ships **empty today** —
see "Honest limits".

> **The floor must be written on the version line the SHIPPED app carries.**
> `.github/workflows/android-build.yml` sets `ANDROID_VERSION_NAME=1.0.${{ github.run_number }}`,
> so real APKs are `1.0.<run>`. A floor of `"1.1"` compares **greater** than
> `"1.0.47"`, which would tell every real device "a new app version is required"
> and kill OTA outright. Write the floor as `1.0.<run>` of the first build that
> carries the required native code. The `android/app/build.gradle` defaults
> (`1.1` / `2`) are a local-build fallback and are not what ships.

## Three rules that are load-bearing

### 1. Fail closed on integrity

`@capgo/capacitor-updater` verifies a bundle **only when you pass a checksum**.
Call `download()` without one and it installs whatever bytes came back.

Verified against the installed plugin's own native source (v8.51.x), not docs:

- Android — `CapgoUpdater.java:776` throws `IOException("Checksum failed")` when
  the supplied checksum does not equal `CryptoCipher.calcChecksum(downloaded)`,
  which is `MessageDigest("SHA-256")`, lowercase hex.
- iOS — `CapacitorUpdaterPlugin.swift:1574` throws `ObjectSavableError.checksum`
  on the same comparison; `CryptoCipher.calcChecksum` is CryptoKit `SHA256`.
- With no `publicKey` configured, `decryptChecksum` returns the value unchanged,
  so a **plaintext hex sha256 is the correct thing to publish**.

`downloadAndApplyUpdate()` in `src/lib/mobileUpdater.js` is the single apply
path. It calls `requireVerifiableBundle()` first, which **throws when the
manifest carries no well-formed sha256** — an unverifiable bundle is refused,
never applied.

### 2. Pin the feed origin in production

`resolveFeedUrl()` honors a `localStorage` override **only when
`import.meta.env.DEV`**. In a shipped build the origin is the
`UPDATE_BASE_URL` constant. Otherwise anything that can write localStorage — an
XSS, a hostile deep link, a third-party script — could repoint the updater at an
attacker's bundle and get arbitrary code running inside the native app.

### 3. Do not nag

`shouldNotifyForVersion()` fires at most once per available version (persisted
in `localStorage`) and never when the app is already current. A denied
notification permission is **silent** and never blocks the in-app prompt.

## Why local notifications, not push

Server-initiated push (FCM + APNs) needs a Firebase project, an Apple push key,
and a sending service — infrastructure this project has not provisioned. A
launch/resume check plus a **local** notification needs none of that and works
on Android and iOS today.

The decision is isolated in `notifyUpdateAvailable()` and the manifest handling
in `MobileUpdateWatcher.handleManifest()`, so a real push trigger can later call
the same code with a server-supplied manifest. Nothing here has to be rewritten
to add push; push only replaces the trigger.

Permission is requested **after** an update is found, never on first paint, so
the OS prompt appears at a moment the user can make sense of.

## Honest limits

- **OTA replaces the WEB BUNDLE only.** It can never deliver native code or a
  new Capacitor plugin. That is what `minNativeVersion` is for: when a web
  bundle starts requiring native code older apps do not carry, raise it and the
  app says *"a new app version is required"* instead of applying a bundle that
  cannot work. Both the Settings card and the launch prompt honor this.
- **iOS builds need a Mac.** This code path works on iOS and JS-only OTA is the
  standard Expo/CodePush pattern, but producing and signing an `.ipa` requires
  macOS plus an Apple Developer account. A Windows machine cannot do it.
- **Notifications require a rebuilt app.** `@capacitor/local-notifications` and
  `@capacitor/app` are native plugins, so only a rebuilt APK/IPA carries them.
  Devices on an older build get the in-app prompt but **no OS notification** —
  the code degrades silently. The next CI Android build after this merge picks
  them up automatically (`run_number` bumps the version line).
- **`minNativeVersion` is deliberately empty right now.** The graceful
  degradation above means this bundle is safe on every existing build, so
  declaring a floor would strand users for no benefit. The mechanism exists for
  the next change that genuinely cannot degrade.

## Files

| File | Role |
| --- | --- |
| `scripts/build-mobile-bundle.mjs` | Publishes the zip + `latest.json` (postbuild) |
| `src/lib/mobileUpdater.js` | Manifest fetch/validate, version compare, native floor, the single verified apply path |
| `src/lib/mobileUpdateNotifier.js` | Notification gating, permission, payload |
| `src/components/mobile/MobileUpdateWatcher.jsx` | Launch + resume check, notification, in-app prompt (mounted in `src/App.jsx`) |
| `src/components/settings/MobileUpdateCard.jsx` | Manual "Check for Updates" |
| `package.json` -> `mobile.minNativeVersion` | The declared native floor |

Tests: `src/lib/mobileUpdater.test.js`, `src/lib/mobileUpdateNotifier.test.js`,
`src/components/mobile/MobileUpdateWatcher.test.jsx`,
`tests/unit/mobileBundleManifest.test.js`.
