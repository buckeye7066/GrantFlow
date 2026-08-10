# Repo-direct Android updates

GrantFlow publishes a signed release APK from `main` after the repository release gates pass. The Android package id remains `com.grantflow.app`, and subsequent releases use the same persistent signing keystore.

## One-time bootstrap for older repo-installed copies

The previous GitHub workflow distributed a `grantflow-debug-apk` artifact. Android debug APKs are signed with a debug certificate, while the new update feed uses the persistent release/upload certificate. Android intentionally refuses to install an APK over an existing package when the signing certificates differ.

If the copy currently installed on the phone came from the old `grantflow-debug-apk` artifact, back up any device-local data that matters, uninstall that debug-signed copy once, and install the first `GrantFlow-*.apk` from the GitHub Android release feed. After that bootstrap, future repo-direct releases can update in place because the package id and signing identity remain stable.

If the installed copy was already signed with the persistent GrantFlow keystore, no uninstall is required. Compare its signing certificate with the `grantflow-signing-cert.sha256` asset published beside every release before the first update.

## Release safety

The workflow runs the authoritative release gates, verifies the configured signing identity against the prior Android release fingerprint after bootstrap, verifies the built APK certificate, publishes an APK checksum, prevents stale overlapping releases, and keeps repository write credentials out of build/test steps.
