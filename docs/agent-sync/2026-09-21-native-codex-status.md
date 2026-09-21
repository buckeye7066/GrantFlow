# Native Codex status diagnostics

The Windows official Codex 0.155.1 client can print two nonfatal bootstrap
warnings to stderr before its successful `Logged in using ChatGPT` status:
stale arg0 cleanup and PATH alias creation. GrantFlow previously rejected that
combined output even when the native command exited zero.

The status parser now accepts only those known leading warning lines followed
by exactly one ChatGPT status. Unknown diagnostics, API-key authentication,
duplicate statuses and nonzero native exit codes remain rejected. No credential
files are read or moved, and the app-specific profile remains separate from the
Codex launcher's profile.

Verification: 13 native Codex unit tests passed (exit 0), including the captured
warning shape and negative authentication cases. The actual app-specific login
status was recognized. Actual inference still failed to initialize the native
app-server client with Windows access denied; a successful login-status probe
does not establish that inference works in this workspace.
