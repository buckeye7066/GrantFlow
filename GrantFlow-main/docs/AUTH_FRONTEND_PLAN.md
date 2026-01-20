The new authentication backend introduces real user identities, OTP-based email sign-in, space for phone and social providers, and rotating access/refresh tokens. To expose that functionality we need to replace the old single-field “enter your profile ID” form with a guided multi-channel experience that works both in the marketing splash page (`/login`) and within the dashboard when an unauthenticated visitor arrives.

## Objectives

1. Support three entry paths end-to-end:
   - **Email magic code** (implemented and live).
   - **Phone number + OTP** (wired to Twilio with preview-code fallback in non-production environments).
   - **Social sign-in** (Google, Facebook, Yahoo) via the `/api/auth/:provider/start` + `/auth/callback` handshake.
2. Provide an in-dashboard re-auth experience that reuses the same components (e.g. when a session expires or when the user deliberately logs out).
3. Surface the richer user context returned by `GET /api/auth/me` (display name, avatar, linked profiles) and allow the user to switch profiles after logging in.
4. Keep the experience on-brand with the existing `GrantFlow` aesthetic and responsive layout.

## Proposed UI & UX

### Entry point (`/login`)

| Step | Description | Notes |
| ---- | ----------- | ----- |
| 1. Welcome panel | Intro copy, hero illustration, CTA to “Sign in or create an account”. | Replicate existing hero but adjust text for “Sign in or create an account” to reflect multi-channel options. |
| 2. Auth methods selector | Tabs or segmented control for “Email”, “Phone”, “More options”. | Use `@radix-ui/react-tabs` to render three tabs. Default to “Email” since that flow is ready today. |
| 3. Email flow | Two-step flow: “Enter email” → “Enter 6-digit code”. | - Step 1: single input with “Send code” button. On success, show feedback and reveal code entry.<br>- Step 2: use `input-otp` component for 6-digit code. Include resend timer and fallback contact link. |
| 4. Phone flow | Collect phone number, trigger `/api/auth/phone/start`, and advance to code entry. | Display success messaging (including preview code in dev logs), enforce resend cooldown, and verify via `/api/auth/phone/verify`. |
| 5. Social | Buttons for providers (Google, Facebook, Yahoo) that redirect through `/api/auth/:provider/start`. | Upon return, handle the `/auth/callback` route to capture tokens (or error) and hydrate the auth store via `loginWithTokens`. |
| 6. Post-verification | On success, call the relevant verify endpoint and persist `accessToken`/`refreshToken` via the shared `auth` store. Redirect to `/dashboard` (or previously requested URL). | Hydrate `auth.user`, `profiles`, and `active_profile_id`; expose the session to the layout header/profile switcher. |

### In-dashboard re-auth modal

When the API client (or React Query middleware) detects a 401 it should:

1. Trigger the centralized “session expired” dialog mounted near the root (`<SessionExpiredDialog />`).
2. Render the same Email/Phone/Social tabs component so the user can re-auth without losing context.
3. On success, invoke the appropriate auth-store helper, close the dialog, and retry the original request (or refresh the page).

### Profile switcher update

With `GET /api/auth/me` now returning `profiles` and `active_profile_id`, update the existing `ProfileSwitcher` so it:

- Pulls available profiles from `auth.user.profiles`.
- Highlights the active profile, and when the user selects a different one, call the new `POST /api/auth/profile/switch` (to be implemented in a follow-up).
- Update the `useAuthStore` state so `ProfileOverview` and other components react.

### Client-side state

Introduce a dedicated `src/stores/auth.ts` (or `.tsx`) that:

- Keeps `accessToken`, `refreshToken`, `user`, `activeProfileId`, and expiry timestamps.
- Exposes helpers `signInWithEmail`, `verifyEmailCode`, `refreshSession`, `logout`.
- Handles storing tokens in memory + `localStorage` (not cookies, since we rely on bearer tokens).
- Implements a `useAuthGuard` hook that checks token freshness, hydrates from `localStorage`, and orchestrates refresh flows.

> _Note_: The existing `api` client already injects `Authorization` headers via `@base44/sdk`. We’ll need to extend or wrap that client so it can read the current access token from `useAuthStore` (or similar) instead of pulling the legacy profile ID.

## Component breakdown

| Component | Responsibility | Key props |
| --------- | -------------- | --------- |
| `AuthShell` | Shared wrapper for login modal/page, handles background layout, error slots. | `children`, optional `title`, `subtitle`, `onClose`. |
 | `AuthMethodTabs` | Renders `Tabs` for Email / Phone / Social, handles state transitions for multi-step flows. | `defaultTab`, `onComplete`. |
 | `EmailSignInForm` | Manage email → code flow using `react-hook-form`, call backend start/verify endpoints via `auth` store. | `onComplete`, `onBack`. |
| `PhoneSignInForm` | Manages phone → OTP flow, including resend cooldowns and verification. | `onComplete`, `defaultPhone?`. |
| `SocialSignInButtons` | Renders provider buttons and launches `/api/auth/:provider/start`. | `providers` config. |
 | `SessionExpiredDialog` | Global modal triggered when tokens expire. Embeds `AuthMethodTabs`. Integrated with `useAuthStore`. |

## Routing & Navigation

- `/login` route should be accessible when the user is signed out; if `auth.user` exists, redirect to `/dashboard`.
- Within the dashboard, add an overlay route or context-based dialog to preserve background state when prompting to re-auth.
- Ensure the new `AuthMethodTabs` is slotted into both contexts so we maintain parity.

## API interactions

- Email & phone flows call the new `/api/auth/*` endpoints and rely on preview codes in non-production environments for automated testing.
- Social flows redirect the browser to `/api/auth/:provider/start`; the callback page uses `authStore.loginWithTokens` to finalise the session and gracefully handles provider errors.
- The shared API client injects bearer tokens, attempts refreshes automatically, and raises session-expired states when refresh fails.

## Visual cues & copy

- After sending the email code, show a success inline alert with “We emailed a 6-digit code to jane@example.com.”
- Show countdown timer for resending the code and disable the button until it elapses.
- Provide help text like “Didn’t receive the code? Check your spam folder or [contact support].”
- For social login, show provider logos with subtle “Redirecting…” copy while the browser navigates.
- Ensure `SessionExpiredDialog` uses supportive language (“Your session expired. Let’s get you signed back in.”) with options to re-auth or go back to the landing page.

## Mobile considerations

- Tabs should be scrollable on small screens.
- The code entry component must be finger-friendly with auto-focus.
- The session-expired dialog should use a full-screen sheet on mobile for clarity.

## Dependencies & follow-up work

- `input-otp` is already in `package.json`; ensure it is consumed in the new form.
- `libphonenumber-js` (or a similar helper) can improve international number validation, although the current MVP relies on backend normalization.
- The social flow launches via `window.location` → `/api/auth/:provider/start`; the `/auth/callback` route shares logic with the session-expired path to hydrate the store after redirect.

## Acceptance criteria (updated)

- Navigating to `/login` shows the tabbed experience with fully functional Email, Phone, and Social options.
- Completing the email or phone OTP flow triggers the backend, stores access/refresh tokens, and redirects to the dashboard where the new `auth` store is populated.
- Launching a social provider round-trips through `/api/auth/:provider/start` and `/auth/callback`, hydrating the auth store on success and surfacing a friendly error on failure.
- On 401 responses, the session dialog appears, and re-authing through any channel refreshes tokens without a full-page reload.
- The user dropdown reflects `auth.user.display_name` and allows switching between `auth.user.profiles` (follow-up API work pending).

## Testing

- `npm run preview` + `node scripts/smoke-login.mjs` — asserts the login surface renders all three auth tabs and their CTAs.
- `node scripts/smoke-auth-callback.mjs` — verifies the `/auth/callback` UX handles provider errors and failed token exchanges gracefully.
- End-to-end OTP verification can be exercised locally by capturing the preview codes emitted to the dev console; CI can toggle `SMOKE_DEBUG=1` to surface the codes during the smoke run.
*** End Patch
