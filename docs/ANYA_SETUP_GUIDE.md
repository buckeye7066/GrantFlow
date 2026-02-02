# Anya AI Assistant - Setup & Configuration Guide

## Overview
Anya is GrantFlow's intelligent grant management copilot. This guide ensures all environment and configuration requirements are properly met so Anya can operate reliably with full capabilities.

## ✅ Critical Requirements Checklist

### 1. Environment Variables (MUST be set)
- [ ] `AUTH_JWT_SECRET` - Stable JWT signing key (32+ random bytes)
- [ ] - [ ] `ANTHROPIC_API_KEY` - Claude API key for Anya's core operations
- [ ] - [ ] `ADMIN_TOKEN` or `ANYA_ADMIN_TOKEN` - For admin-level operations
- [ ] - [ ] Database connectivity (PostgreSQL or SQLite)

- [ ] ### 2. Database Setup (MUST be completed)
- [ ] - [ ] Database migrations run: `npm run migrate`
- [ ] - [ ] Tables created including: `users`, `profiles`, `anya_runs`, `crawler_jobs`
- [ ] - [ ] Admin user created with `is_admin = 1` flag

- [ ] ### 3. Backend Configuration (MUST be enforced)
- [ ] - [ ] Middleware: `requestContext.js` initialized on startup
- [ ] - [ ] Request context `req.ctx` attached to all requests
- [ ] - [ ] Admin checks use database verification, NOT token claims

- [ ] ---

- [ ] ## Step 1: Generate Secure AUTH_JWT_SECRET

- [ ] Anya requires a stable JWT secret for session management. Sessions MUST survive server restarts.

- [ ] ### On Linux/Mac/Windows (Git Bash):
- [ ] ```bash
- [ ] # Generate 48 bytes of random data, base64-encoded (64 characters)
- [ ] openssl rand -base64 48

- [ ] # Example output:
- [ ] # xK9pQvZ2jK3mL4nO5pQrStUvWxYzAbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIj
- [ ] ```

- [ ] ### If OpenSSL not available:
- [ ] ```bash
- [ ] # Node.js method
- [ ] node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
- [ ] ```

- [ ] ### Store this securely:
- [ ] ```bash
- [ ] # Copy the output and add to your .env file:
- [ ] echo "AUTH_JWT_SECRET=<paste-your-generated-secret>" >> .env

- [ ] # Verify it's set (32+ characters, alphanumeric + special chars):
- [ ] echo $AUTH_JWT_SECRET | wc -c  # Should be 65+ (64 chars + newline)
- [ ] ```

- [ ] ---

- [ ] ## Step 2: Configure Anthropic API Key

- [ ] Anya uses Anthropic's Claude for grant analysis and recommendations.

- [ ] ### Get your API key:
- [ ] 1. Visit https://console.anthropic.com/
- [ ] 2. Create account or sign in
- [ ] 3. Navigate to "API Keys" section
- [ ] 4. Create new API key
- [ ] 5. Copy the key (format: `sk-ant-...`)

- [ ] ### Add to .env:
- [ ] ```bash
- [ ] echo "ANTHROPIC_API_KEY=sk-ant-your-actual-key-here" >> .env
- [ ] ```

- [ ] ### Verify (production):
- [ ] ```bash
- [ ] # Backend will fail fast if key is invalid
- [ ] npm run dev

- [ ] # Should see: "✅ Anthropic API key loaded"
- [ ] # If missing: "❌ ANTHROPIC_API_KEY not found - Anya will not operate"
- [ ] ```

- [ ] ---

- [ ] ## Step 3: Configure Admin Token (Optional but Recommended)

- [ ] For admin-only Anya operations (crawler management, profile repair, etc.).

- [ ] ### Generate admin token:
- [ ] ```bash
- [ ] node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
- [ ] ```

- [ ] ### Add to .env:
- [ ] ```bash
- [ ] echo "ADMIN_TOKEN=your-generated-token-here" >> .env
- [ ] # OR
- [ ] echo "ANYA_ADMIN_TOKEN=your-generated-token-here" >> .env
- [ ] ```

- [ ] ---

- [ ] ## Step 4: Run Database Migrations

- [ ] Anya requires specific database tables for storing runs and snapshots.

- [ ] ```bash
- [ ] # This creates/updates all necessary tables
- [ ] npm run migrate

- [ ] # Verify tables were created:
- [ ] # - anya_runs (Anya operational audit)
- [ ] # - anya_tool_usage (Tool execution metrics)
- [ ] # - crawler_jobs (Background job tracking)
- [ ] # - profile_context_snapshot (Deterministic profile data)
- [ ] ```

- [ ] ### Expected output:
- [ ] ```
- [ ] ✅ Migration 001: ... completed
- [ ] ✅ Migration 002: ... completed
- [ ] ...
- [ ] ✅ Migration 0011_anya_runs.sql ... completed
- [ ] ✅ All migrations completed successfully
- [ ] ```

- [ ] ---

- [ ] ## Step 5: Create/Configure Admin User

- [ ] Anya's admin tools require a user with `is_admin = 1` in the database.

- [ ] ### Option A: Using seed script (recommended for dev):
- [ ] ```bash
- [ ] npm run seed
- [ ] # This creates a default admin user with all permissions
- [ ] ```

- [ ] ### Option B: Manual database update (production):
- [ ] ```bash
- [ ] # Connect to your database
- [ ] # SQLite:
- [ ] sqlite3 backend/data/grantflow.db
- [ ] UPDATE users SET is_admin = 1 WHERE email = 'your-admin@email.com';

- [ ] # PostgreSQL:
- [ ] psql $DATABASE_URL
- [ ] UPDATE users SET is_admin = 1 WHERE email = 'your-admin@email.com';
- [ ] ```

- [ ] ### Verify admin status:
- [ ] ```bash
- [ ] # Login as admin user
- [ ] # Check browser console: console.log(window.__auth?.user?.is_admin)
- [ ] # Should return: true
- [ ] ```

- [ ] ---

- [ ] ## Step 6: Start Backend with Proper Configuration

- [ ] ### Development:
- [ ] ```bash
- [ ] # Backend loads .env automatically
- [ ] npm run dev

- [ ] # Verify startup messages:
- [ ] # ✅ AUTH_JWT_SECRET validated (stable, 32+ bytes)
- [ ] # ✅ ANTHROPIC_API_KEY loaded
- [ ] # ✅ Request context middleware initialized
- [ ] # ✅ Database connected
- [ ] # ✅ Anya routes registered
- [ ] ```

- [ ] ### Production:
- [ ] ```bash
- [ ] # CRITICAL: Must set environment variables BEFORE starting
- [ ] export AUTH_JWT_SECRET="your-generated-secret"
- [ ] export ANTHROPIC_API_KEY="sk-ant-..."
- [ ] export DATABASE_URL="postgres://..."
- [ ] export NODE_ENV="production"

- [ ] npm run build
- [ ] npm start

- [ ] # If AUTH_JWT_SECRET missing:
- [ ] # ❌ FATAL: AUTH_JWT_SECRET is required in production
- [ ] # ❌ Exiting immediately
- [ ] # (Server will NOT start)
- [ ] ```

- [ ] ---

- [ ] ## Step 7: Verify Anya is Operational

- [ ] ### Via Frontend:
- [ ] 1. Create or select a profile
- [ ] 2. Look for floating purple/blue button (bottom right) labeled "Chat with Anya"
- [ ] 3. Click to open Anya chat panel
- [ ] 4. If disabled/greyed: `isAdmin = false` AND `profileId = null`

- [ ] ### Via CLI:
- [ ] ```bash
- [ ] node scripts/check-anya-status.mjs

- [ ] # Expected output:
- [ ] # 🤖 ANYA OPERATIONAL STATUS CHECK
- [ ] # ✅ Anya endpoint reachable
- [ ] # ✅ Authentication verified
- [ ] # ✅ Tool registry loaded
- [ ] # ✅ Database snapshot support: YES
- [ ] # ✅ Crawler queue support: YES
- [ ] ```

- [ ] ### Via API:
- [ ] ```bash
- [ ] curl -X GET "http://localhost:8080/api/anya/status" \
- [ ]   -H "Authorization: Bearer <your-jwt-token>"

- [ ]   # Response:
- [ ]   # {
- [ ]   #   "operational": true,
- [ ]   #   "version": "1.0.0",
- [ ]   #   "admin_verified": true,
- [ ]   #   "tools_available": 45,
- [ ]   #   "crawlers_queued": 0
- [ ]   # }
- [ ]   ```

- [ ]   ---

- [ ]   ## Step 8: Testing Anya's Capabilities

- [ ]   ### Test 1: Profile Access
- [ ]   ```bash
- [ ]   # As admin user:
- [ ]   # Should be able to view ANY profile without 403 errors
- [ ]   # Verify: Admin checks use req.ctx.isAdmin (from database)
- [ ]   ```

- [ ]   ### Test 2: Crawler Idempotency
- [ ]   ```bash
- [ ]   # Send same crawler request twice:
- [ ]   curl -X POST "http://localhost:8080/api/crawlers/dispatch" \
- [ ]     -H "Content-Type: application/json" \
- [ ]   -d '{"type": "state_county", "profile_id": "123", "state": "CA"}'

- [ ]   # First request: Returns new job ID
- [ ]   # Second request: Returns SAME job ID (not duplicate)
- [ ]   ```

- [ ]   ### Test 3: Session Stability
- [ ]   ```bash
- [ ]   # 1. Get JWT token via login
- [ ]   # 2. Make authenticated request
- [ ]   # 3. Restart backend server
- [ ]   # 4. Make same authenticated request with token
- [ ]   # Expected: Works without re-authentication
- [ ]   # (Requires stable AUTH_JWT_SECRET)
- [ ]   ```

- [ ]   ### Test 4: Anya Tool Execution
- [ ]   ```bash
- [ ]   # As admin user:
- [ ]   curl -X POST "http://localhost:8080/api/anya/tools/invoke" \
- [ ]     -H "Content-Type: application/json" \
- [ ]   -d '{"tool": "admin.crawler.list", "params": {}}'

- [ ]   # Expected:
- [ ]   # {
- [ ]   #   "success": true,
- [ ]   #   "data": [/* list of crawler jobs */]
- [ ]   # }
- [ ]   ```

- [ ]   ---

- [ ]   ## Troubleshooting

- [ ]   ### Problem: "Anya button is greyed out"
- [ ]   **Solution:**
- [ ]   - User is not admin AND not viewing a profile
- [ ]   - Either: `users.is_admin = 1` OR select a profile first

- [ ]   ### Problem: "AUTH_JWT_SECRET is required in production"
- [ ]   **Solution:**
- [ ]   ```bash
- [ ]   export AUTH_JWT_SECRET=$(openssl rand -base64 48)
- [ ]   # Restart backend
- [ ]   ```

- [ ]   ### Problem: "ANTHROPIC_API_KEY not found"
- [ ]   **Solution:**
- [ ]   ```bash
- [ ]   # 1. Get key from https://console.anthropic.com/
- [ ]   # 2. Add to .env: ANTHROPIC_API_KEY=sk-ant-...
- [ ]   # 3. Restart backend
- [ ]   ```

- [ ]   ### Problem: "502 Bad Gateway - Anya endpoint"
- [ ]   **Solution:**
- [ ]   - Check backend is running: `curl http://localhost:8080/api/health`
- [ ]   - Check migrations were run: `npm run migrate`
- [ ]   - Check database is accessible: `npm run test:db`

- [ ]   ### Problem: "Crawler jobs queued but not executing"
- [ ]   **Solution:**
- [ ]   - Verify `crawler_jobs` table exists
- [ ]   - Check idempotency: Same parameters = same job ID
- [ ]   - Verify snapshot was stored: Check `profile_context_snapshot` column

- [ ]   ### Problem: "Admin tools return 403"
- [ ]   **Solution:**
- [ ]   - Verify user `is_admin = 1` in database
- [ ]   - Clear browser cache and re-login
- [ ]   - Check `req.ctx.isAdmin` is set (in backend logs)

- [ ]   ---

- [ ]   ## Environment Variables Summary

- [ ]   ### Critical (MUST SET):
- [ ]   ```
- [ ]   AUTH_JWT_SECRET=<32+ random bytes, base64>
- [ ]   ANTHROPIC_API_KEY=<sk-ant-...>
- [ ]   DATABASE_URL=<postgres://... or sqlite://...>
- [ ]   ```

- [ ]   ### Recommended (for admin features):
- [ ]   ```
- [ ]   ADMIN_TOKEN=<random hex string>
ANYA_ADMIN_TOKEN=<random hex string>
```

### Optional (with sensible defaults):
```
ANYA_ANTHROPIC_TIMEOUT_MS=30000
ANYA_ANTHROPIC_MAX_RETRIES=3
ANYA_ANTHROPIC_COOLDOWN_MS=1000
FEATURE_ANYA_TOOLS=true
```

---

## Verification Checklist - Before Deploying

- [ ] `AUTH_JWT_SECRET` set and 32+ bytes
- [ ] `ANTHROPIC_API_KEY` present and valid
- [ ] `npm run migrate` completed successfully
- [ ] Admin user created with `is_admin = 1`
- [ ] Backend starts without errors
- [ ] Anya button visible for admin or profile owner
- [ ] Crawler jobs have idempotency keys
- [ ] Sessions survive server restart
- [ ] Admin tools accessible to admin users
- [ ] Non-admin users get proper 403 errors

---

## Additional Resources

- [VERIFICATION.md](VERIFICATION.md) - Detailed verification conditions
- [ENVIRONMENT.md](ENVIRONMENT.md) - Complete environment variable list
- [STABILITY_FIXES.md](STABILITY_FIXES.md) - Anya stabilization details
- [backend/routes/anya.js](backend/routes/anya.js) - Anya API routes
- [src/components/anya/](src/components/anya/) - Anya UI components

---

## Support

If Anya is not operational after following this guide:

1. Check backend logs: `npm run dev 2>&1 | grep -i anya`
2. Run status check: `node scripts/check-anya-status.mjs`
3. Verify database: `npm run test:db`
4. Check console for errors: Browser DevTools → Console tab
5. Review [VERIFICATION.md](VERIFICATION.md) for detailed checks

**All five phases of Anya's stabilization have been completed. If you follow this guide, Anya will operate reliably.**
