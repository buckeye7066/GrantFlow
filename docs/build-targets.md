# Choose a build for the recipient

`npm run build:target -- --dry-run` reports the build this computer supports. Remove `--dry-run` to execute it. Use `--target android`, `windows`, `macos`, `ios`, `safari`, or `web` to choose a different recipient explicitly. `--host win32|darwin|linux` is available only during dry runs and cannot spoof the actual build host.

Install the repository dependencies and required toolchains first. The dispatcher does not install dependencies, install the app on a device, deploy servers, or publish releases. Its JSON result names the actual output format, path, and commands. A web build is never described as an EXE, APK, or IPA. Android builds are debug-signed APKs for testing; the existing gated Android workflow remains the production signing and publication path.

Safari and iOS targets build browser assets. Signed iPhone distribution still requires a Mac, Apple credentials, and the existing native workflow; copying an APK or EXE to an iPhone does not install an app. Native macOS and Windows targets, where present in `scripts/build-targets.json`, require their matching build host. GrantFlow provides web/PWA desktop builds rather than native desktop installers.

Build-host detection affects the build command only. Existing installed apps select updates on their own device; this dispatcher does not alter updater identity, copy account sessions, or bundle owner data. Share the appropriate output or public app URL, and each recipient signs in independently.

Check selectors without toolchain work: `npm run test:build-target`.
