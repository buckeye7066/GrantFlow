# Anya Copilot UX — Rollout and Rollback

## Feature flags

| Source | Scope |
|--------|--------|
| **Build-time env** | `VITE_ANYA_COPILOT_ENABLED` / `VITE_ANYA_SCREENSHOT_ENABLED` define **defaults** only. |
| **Persisted preferences** | `custom_preferences.feature_flags` (anyaCopilotEnabled, anyaScreenshotEnabled) override env and **persist across refresh and login** (stored in DB via `PUT /api/preferences`). |

- **Anya Copilot** (anyaCopilotEnabled): gates Anya context provider, "Next steps" panel, "Use current screen".
- **Anya Screen Capture** (anyaScreenshotEnabled): allows "Capture screen" (user-triggered only). Default OFF.
- **Admin-only**: Settings → Features tab shows toggles for both; changes are written through to the backend. Non-admin users receive server default (anyaCopilotEnabled: true on first preference load via migration).

## Enabling in production

1. **Build defaults** (optional): set `VITE_ANYA_COPILOT_ENABLED=true` (and optionally `VITE_ANYA_SCREENSHOT_ENABLED=true`) at build to make the default ON for new users.
2. **Per-user**: admins use Settings → Features to turn Anya Copilot / Screen Capture on or off; state persists in DB.
3. **First load**: if a user has no `feature_flags` in preferences, the backend migrates once and sets `anyaCopilotEnabled: true`, `anyaScreenshotEnabled: false`.

## Rollback

1. **Per-user**: admin can turn off Anya Copilot in Settings → Features; takes effect immediately and persists.
2. **Build default**: set `VITE_ANYA_COPILOT_ENABLED` to false (or unset) and redeploy; new users and users without a saved preference get copilot OFF.
3. **Code revert**: revert the Anya copilot feature branch; all new Anya UX is behind the same preference/flag contract.

## Verification

- **Persistence**: log in, enable Anya in Settings → Features, open Anya and confirm "Next steps"; refresh page — Anya and settings remain. Logout and login again — settings still applied.
- **Smoke**: `npm run smoke` — app load, login, key routes; `npm run e2e` includes login → key routes → Anya → refresh persistence → logout.
