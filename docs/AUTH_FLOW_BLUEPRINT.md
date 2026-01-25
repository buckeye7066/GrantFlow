## Multi-Channel Authentication Blueprint

### 1. Goals & Constraints
- Support login via **email**, **SMS phone number**, and **social providers** (Google, Facebook, Yahoo – extensible).
- Preserve existing admin-token and profile-token behaviours during migration.
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
- Keep legacy profile-token auth; mark tokens in `profiles` as deprecated once new flow is live.

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
   - Return `{ accessToken, refreshToken, expiresIn, user }`.

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
   - Validates token (unconsumed, not expired), sets `users.password_hash`, consumes token, issues session tokens.
3. **`POST /api/auth/password/login`**
   - body `{ email, password }`
   - Validates password hash and issues session tokens.

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
   - Upserts provider tokens/metadata in `user_providers` and issues GrantFlow access/refresh tokens via `user_sessions`.

### 4. Session & Token Strategy
- Use signed JWT access tokens (15 min) + opaque refresh tokens stored hashed in `user_sessions`.
- Access token payload: `{ sub: user_id, profile_id?, roles: ['admin'?''] }`.
- Refresh flow: `POST /api/auth/refresh` → rotate refresh token; enforce single-use.
- Logout: `POST /api/auth/logout` → revoke current session; optionally support `logout_all`.

### 5. Authorization Mapping
- Default `profile_id` = first profile linked to user, but support explicit selection.
- `/api/auth/me` should return `{ user, profiles, active_profile_id }`.
- Middleware updates:
  - Accept `Authorization: Bearer <jwt>`; verify signature, load session.
  - Admin token support: if header matches `ADMIN_TOKEN`, treat as admin session without DB lookup.
  - Legacy profile-token fallback (until migration complete).

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
3. **Token storage**: store access token in memory, refresh token via HTTP-only cookie or secure storage; plan for SSR via Vercel (consider `withCredentials`).
4. **Route guards**: update React router to redirect to `/login` when `auth.me` fails.

### 8. Security & Compliance
- Hash verification codes (`bcrypt` or `scrypt`) and enforce per-credential rate limits (`attempt_count`, `last_sent_at`).
- Expire OTPs in 10 minutes, max 5 attempts.
- Audit logging: append entries to new table `auth_audit_logs` (optional) for admin review.
- CSRF protection: ensure refresh/logout handled via POST with CSRF token or rely on double-submit cookie if using cookies.
- GDPR considerations: allow users to delete credentials; store minimal provider tokens (encrypt at rest using `crypto` + `ENCRYPTION_KEY` env).

### 9. Migration Strategy
1. Deploy schema changes (new tables, profile references).
2. Create admin UI script to backfill `users` from existing profiles (generate stub emails like `profile-{id}@placeholder.local` if none).
3. Roll out backend route changes behind feature flag `AUTH_V2_ENABLED`.
4. Iterate UI while keeping legacy bearer tokens working for current users.
5. Once stable, disable direct profile-token logins and require the new flow.

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
- Should clients stay stateless (pure JWT) or move refresh token to HTTP-only cookie for better security?
- Confirm which social providers are priority for phase 1.
- Determine if one user can manage multiple profiles (likely yes for consultants); design profile-switch UX accordingly.
