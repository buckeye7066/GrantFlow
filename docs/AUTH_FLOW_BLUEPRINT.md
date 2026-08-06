## Multi-Channel Authentication Blueprint

> **Current contract note.** This document began as a design blueprint. The
> session, cookie, admin-authority, and legacy-profile-token statements below
> have been reconciled with the current implementation; future-provider items
> remain plans until their release evidence is recorded.

### 1. Goals & Constraints
- Support login via **email**, **SMS phone number**, and **social providers** (Google, Facebook, Yahoo – extensible).
- Preserve explicitly configured service-token integrations without treating a
  raw JWT role claim as admin authority; retire profile-id bearer auth from
  every deployed production runtime.
- Allow every login channel to resolve to a **single user identity** that can be mapped to one or more profiles.
- Avoid locking the product to a single vendor; favour pluggable providers (Twilio/Postmark for OTP, OAuth providers for social).
- Keep the backend deployable on Railway, with minimal additional infrastructure.

### 2. Proposed Data Model Additions
| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `users` | Canonical person record | `id`, `created_at`, `updated_at`, `primary_email`, `primary_phone`, `display_name`, `avatar_url`, `is_admin` |
| `user_credentials` | Email + phone verification secrets | `id`, `user_id`, `type` (`email_otp`, `phone_otp`), `identifier` (email / E.164 phone), `secret_hash`, `verified_at`, `last_sent_at`, `attempt_count` |
| `user_providers` | Social OAuth bindings | `id`, `user_id`, `provider` (`google`, `facebook`, `yahoo`, …), `provider_account_id`, `access_token`, `refresh_token`, `expires_at`, `scopes` |
| `user_sessions` | API sessions | `id`, `user_id`, `profile_id` (nullable), `issued_at`, `expires_at`, `ip_address`, `user_agent`, `refresh_token_hash` |
| `user_verification_codes` | One-time codes for email/SMS | `id`, `credential_id`, `code_hash`, `expires_at`, `consumed_at`, `attempt_count`, `metadata(json)` |
| `oauth_states` | Ephemeral OAuth state + PKCE verifier | `id`, `provider`, `state`, `code_verifier`, `redirect_to`, `metadata`, `expires_at` |

Schema updates:
- Add `user_id` column to `profiles` (nullable initially).
- Profile IDs are identifiers, not production bearer credentials. The legacy
  profile-token path is disabled by default, permitted only by explicit opt-in
  outside production, and must not be used as a migration bridge.

### 3. Authentication Flows

#### Email OTP / Magic Link
1. **`POST /api/auth/email/start`**
   - body `{ email }`
   - Normalise/lookup. If no `user_credentials`, create placeholder `users` row and credential record.
   - Generate 6-digit code + optional magic-link token.
   - Persist hashed code in `user_verification_codes`; send email via transactional provider.
2. **`POST /api/auth/email/verify`**
   - body `{ email, code, profile_id? }`
   - Validate attempts & expiry; mark credential verified.
   - Create session (`user_sessions`) optionally scoped to requested `profile_id` (validate ownership).
   - Return the short-lived access token and user payload; deliver the opaque
     refresh token only through the host-only, path-scoped HttpOnly cookie.

Magic link variant: `GET /api/auth/email/callback?token=...` to consume JWT-style token.

#### First-login password setup + password login
1. **`POST /api/auth/password/setup/start`**
   - body `{ email }`
   - Production gate: allow only admin emails or emails that match an existing profile email
     (stored in `profile_sections` `basic_information.data.email`).
   - If unauthorized: `403 { error_type: 'unauthorized_email', redirect_to: '/ServiceApplication' }`.
   - If user already has `users.password_hash`: `200 { ok:true, status:'password_exists' }`.
   - Otherwise: create one-time token in `password_setup_tokens` (TTL default 30m), email a link:
     `.../set-password?token=<token>`, return `202 { ok:true, status:'password_setup_email_sent' }`.
2. **`POST /api/auth/password/setup/complete`**
   - body `{ token, password }`
   - Validates token (unconsumed, not expired), sets `users.password_hash`,
     consumes the token, and issues an access token plus the HttpOnly refresh cookie.
3. **`POST /api/auth/password/login`**
   - body `{ email, password }`
   - Validates the password hash and issues an access token plus the HttpOnly refresh cookie.

#### Phone SMS OTP
1. **`POST /api/auth/phone/start`** with `{ phone }`.
2. Send OTP via Twilio/MessageBird; store hashed code.
3. **`POST /api/auth/phone/verify`** similar to email.

#### Social OAuth (Google/Facebook/Yahoo)
1. **`GET /api/auth/:provider/start`**
   - Validates provider configuration and generates a signed state + optional PKCE verifier (persisted in `oauth_states`).
   - Redirects the browser to the provider authorization URL (`state` and optional `code_challenge`).
2. **`GET /api/auth/:provider/callback`**
   - Validates and consumes the stored state; rejects replayed or foreign states.
   - Exchanges `code` for provider tokens (supports PKCE for Google/Yahoo, standard secret for Facebook).
   - Fetches profile info (email, display name, avatar).
   - Looks up `user_providers` by `(provider, provider_account_id)`. If none, attempts to match an existing `users` record by verified email; otherwise creates a new `users` entry.
   - Upserts provider tokens/metadata in `user_providers`, creates the GrantFlow
     session, and redirects with only a short-lived one-time handoff in the URL
     fragment. The frontend exchanges that handoff on its own origin; no access
     or refresh token appears in a callback URL.

### 4. Session & Token Strategy
- Use signed JWT access tokens in browser memory + opaque refresh tokens stored
  hashed in `user_sessions` and delivered only in a host-only HttpOnly cookie.
- Access token payload: `{ sub: user_id, sid, profile_id?, roles }`. `roles` is
  provisional identity metadata only; authorization must use the canonical
  request context resolved from the trusted `users` row or validated
  synthetic-service-token provenance.
- Web refresh cookies are host-only, HttpOnly, `SameSite=Strict`, Secure in
  production, and scoped to `/api/auth` plus the configured app-base auth path.
  Native Capacitor origins use the explicit Secure/`SameSite=None` exception.
- Refresh flow: same-origin `POST /api/auth/refresh` with credentials included →
  compare-and-swap rotation, hash-only reuse history, and a new cookie. Body
  refresh tokens are rejected.
- Refresh/logout require an approved Origin/Sec-Fetch-Site context plus
  `X-Requested-With: XMLHttpRequest`; logout revokes the current session and
  expires every supported auth cookie path.
- OAuth callbacks place a short-lived, one-time handoff in the URL fragment;
  the frontend exchanges it on its own origin. Access/refresh tokens never
  appear in callback query parameters.

### 5. Authorization Mapping
- Default `profile_id` = first profile linked to user, but support explicit selection.
- `/api/auth/me` should return `{ user, profiles, active_profile_id }`.
- Middleware updates:
  - Accept `Authorization: Bearer <jwt>`; verify signature and load provisional
    identity/session data, then resolve `req.ctx.isAdmin` from the DB. Missing
    users rows and DB errors fail closed for admin and profile/org access.
  - `ADMIN_TOKEN` is limited to validated synthetic-service provenance; downstream
    authorization uses the canonical request context. A deployed operator email
    is environment-owned and is trusted only after it is loaded from the user's
    DB row; there is no source-controlled production admin identity.
  - Legacy profile-token auth is disabled by default, requires explicit non-production
    opt-in, and is forbidden in deployed production.

### 6. API Surface Summary
```
POST   /api/auth/email/start
POST   /api/auth/email/verify
POST   /api/auth/password/setup/start
POST   /api/auth/password/setup/complete
POST   /api/auth/password/login
POST   /api/auth/phone/start
POST   /api/auth/phone/verify
GET    /api/auth/:provider/start
GET    /api/auth/:provider/callback
POST   /api/auth/refresh
POST   /api/auth/logout
GET    /api/auth/me
POST   /api/auth/profile/switch      { profile_id }
```
Future enhancements: `POST /api/auth/mfa/enable`, `POST /api/auth/password/set` (if needed).

### 7. Frontend Integration Plan
1. **State management**: extend `src/api/client.js` auth handler to store/refresh tokens (likely using `axios` interceptors or `fetch` wrappers).
2. **UI flow**
   - New `Login` page with tabs:
     - Email → collects email, handles code entry.
     - Phone → collects phone with country picker.
     - Social → buttons redirecting to backend endpoints.
   - Post-login: if multiple profiles, show profile switcher modal (use `PipelineAutomationPanel` style sheet).
3. **Token storage**: access token in memory; refresh token in the host-only,
   path-scoped HttpOnly cookie issued through the Vercel `/api` rewrite. Every
   request that may refresh includes credentials.
4. **Route guards**: update React router to redirect to `/login` when `auth.me` fails.

### 8. Security & Compliance
- Hash verification codes (`bcrypt` or `scrypt`) and enforce per-credential rate limits (`attempt_count`, `last_sent_at`).
- Expire OTPs in 10 minutes, max 5 attempts.
- Audit logging: append entries to new table `auth_audit_logs` (optional) for admin review.
- Refresh/logout are POST-only and enforce the implemented request-integrity
  contract: approved `Origin`/`Sec-Fetch-Site` plus
  `X-Requested-With: XMLHttpRequest`. Refresh tokens in request bodies are
  rejected.
- GDPR considerations: allow users to delete credentials; store minimal provider tokens (encrypt at rest using `crypto` + `ENCRYPTION_KEY` env).

### 9. Release and Migration Strategy
1. Apply the additive session/history/OAuth-handoff migrations and verify their
   keys, indexes, foreign keys, and timestamp types.
2. Deploy the Railway backend first and prove `/readyz`, cookie attributes,
   refresh rotation/reuse behavior, and one-time OAuth handoff consumption.
3. Promote the exact same intended merge SHA on Vercel immediately afterward.
   The new frontend cannot establish a session against the old backend, while
   the old frontend cannot refresh against the cookie-only backend. Treat the
   interval as a controlled maintenance window, not a mixed-version steady state.
4. Existing sessions whose only browser credential lived in `localStorage` are
   deliberately not migrated. Those values are deleted without being read or
   transmitted, and affected users sign in once. There is no JavaScript-readable
   compatibility bridge.
5. Record backend and frontend deployed SHAs, migration receipts, cookie-path
   checks, forced-reauth impact, authenticated smoke journeys, and the rollback point.

### 10. External Providers Checklist
- **Email**: Postmark / SendGrid (env vars: `EMAIL_API_KEY`, `EMAIL_FROM`).
- **SMS**: Twilio (env vars: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`).
- **OAuth** (set both the generic and `AUTH_`-prefixed variants to keep local/prod parity):
  - Google: `AUTH_GOOGLE_CLIENT_ID`, `AUTH_GOOGLE_CLIENT_SECRET`, optional `AUTH_GOOGLE_REDIRECT_URI` (defaults to `{AUTH_PUBLIC_URL}/api/auth/google/callback`).
  - Facebook: `AUTH_FACEBOOK_CLIENT_ID`, `AUTH_FACEBOOK_CLIENT_SECRET`, optional `AUTH_FACEBOOK_REDIRECT_URI`.
  - Yahoo: `AUTH_YAHOO_CLIENT_ID`, `AUTH_YAHOO_CLIENT_SECRET`, optional `AUTH_YAHOO_REDIRECT_URI`.
- Shared callback helpers: `AUTH_PUBLIC_URL` (backend self URL) and `AUTH_FRONTEND_URL`/`AUTH_FRONTEND_APP_BASE` to constrain redirect targets.
- Password setup TTL: optional `AUTH_PASSWORD_SETUP_TTL` (seconds, default 1800).

### 11. Open Questions / Next Steps
- Do we need MFA beyond OTP? (e.g., TOTP apps).
- Verify cookie flags, one-time OAuth handoffs, forced reauthentication, and
  coordinated Railway/Vercel rollback on the exact release SHA.
- Confirm which social providers are priority for phase 1.
- Determine if one user can manage multiple profiles (likely yes for consultants); design profile-switch UX accordingly.
