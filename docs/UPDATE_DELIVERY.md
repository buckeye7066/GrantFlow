# Update delivery

Every production web build emits app-update.json with a unique build ID and a numeric bundleVersion. Browser tabs and installed PWAs check on open, return to the foreground, reconnection, and once a minute while visible. Update validates the deployed shell before navigating; Later leaves the update action available. No profile, vault, localStorage, or IndexedDB data is cleared.

This is an in-app notification and an optional local system notification where permission is already granted. It is not server push to a closed application. No APNs, FCM, or Web Push sending service is configured.

GrantFlow and GeneMap publish a checksum-verified OTA archive from the same built identity. Already-installed clients can compare its numeric version even when package.json is unchanged. New native builds embed the same identity. Installation rechecks native compatibility, and incompatible native changes require a signed app release. Older clients without an update checker need one initial signed app update.

Incognito keeps remote web-bundle installation disabled. Android checks the existing public signed-package release channel; Update opens that package and Android asks for installation approval. The release metadata must match the pinned package, host, filename, and established signing certificate. There is no configured Incognito iOS distribution channel.

Tests are build and client regression evidence. Physical-device installation, Safari/iOS behavior, and notifications with the app fully closed require separate device evidence and are not implied by a passing CI run.

