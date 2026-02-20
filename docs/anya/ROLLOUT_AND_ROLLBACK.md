# Anya Copilot UX — Rollout and Rollback

## Feature flags

| Flag | Default | Scope |
|------|---------|--------|
| **VITE_ANYA_COPILOT_ENABLED** | OFF (false) | When true at build time: enables Anya context provider, "Next steps" panel, "Use current screen". In production this must be set at build (e.g. in Vercel/Railway env). |
| **VITE_ANYA_SCREENSHOT_ENABLED** | OFF (false) | When true: allows "Capture screen" (user-triggered only). Default OFF everywhere. |

- **ANYA_COPILOT_ENABLED** is the main gate: with it OFF, the app behaves identically to main (no AnyaContextProvider, no new Anya UI).
- In **development**, admins and devs can toggle the copilot via **Settings → Features → Anya Copilot UX** (localStorage override); the page reloads to apply.

## Enabling in staging

1. Set build env for the staging app:
   - `VITE_ANYA_COPILOT_ENABLED=true`
2. Rebuild and deploy.
3. (Optional) For screenshot capture: `VITE_ANYA_SCREENSHOT_ENABLED=true` (still user-triggered only).

## Rollback

1. **Immediate**: Set `VITE_ANYA_COPILOT_ENABLED` to false (or unset) and redeploy. No code revert required.
2. **Code revert**: Revert branch `ux/anya-copilot-safe`; all new Anya UX is behind the flag so revert restores previous behaviour.

## Verification

- With flags **OFF**: run `npm run smoke` and confirm app load, login, Pipeline, Settings; no "Next steps" or "Use current screen" in Anya.
- With flags **ON**: open Anya, confirm "Next steps" and "Use current screen" appear; click "Use current screen" and confirm a context message is posted without crash.
