# Production Hardening - Environment & Configuration Guide

## Overview

This document describes the production hardening improvements made to GrantFlow, including environment variable requirements, security best practices, and operational guidelines.

## Critical Environment Variables

### AUTH_JWT_SECRET (REQUIRED in production)

**Purpose:** Secret key for signing JWT authentication tokens.

**Requirements:**
- MUST be set in production (application will fail to start if missing)
- MUST be at least 32 bytes of random data
- MUST be stable across deployments (sessions will be invalidated if changed)
- MUST NOT be the development default (`grantflow-dev-secret`)

**Generation:**
```bash
# Generate secure random secret (recommended)
openssl rand -base64 48

# Or use Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

**Configuration:**
```bash
# Railway/Vercel
AUTH_JWT_SECRET="<your-generated-secret>"

# Or use JWT_SECRET as alias
JWT_SECRET="<your-generated-secret>"
```

**Fail-Fast Behavior:**
The application will immediately exit with an error message if:
1. `AUTH_JWT_SECRET` is not set in production
2. `AUTH_JWT_SECRET` is set to the insecure development default
3. No runtime generation of secrets - sessions are stable

**Migration from Previous Versions:**
Previous versions would generate ephemeral secrets at runtime, causing session invalidation on restart. This has been removed. You MUST set `AUTH_JWT_SECRET` before deploying to production.

---

## Admin Authorization

### Database-Backed Admin Status

**Change:** Admin authorization now exclusively uses the `users.is_admin` column in the database.

**Removed:** 
- Hardcoded admin email checks in runtime code
- Email substring allowlists
- Token-only admin claims without DB verification

**How It Works:**
1. Request middleware (`requestContext.js`) builds `req.ctx` with DB-backed `isAdmin` flag
2. All authorization decisions use `req.ctx.isAdmin`
3. Admin status is verified against `users.is_admin` column

**Initial Admin Setup:**
Admin status is still assigned during user creation based on `ADMIN_EMAIL` / `ADMIN_EMAILS` environment variables. This is the ONLY time email-based admin assignment occurs.

```bash
# Configure admin emails for initial setup
ADMIN_EMAIL="your-admin@example.com"
ADMIN_EMAILS="admin1@example.com,admin2@example.com"
```

**Setting Admin Status Manually:**
```sql
-- Grant admin privileges to a user
UPDATE users SET is_admin = TRUE WHERE primary_email = 'admin@example.com';

-- Revoke admin privileges
UPDATE users SET is_admin = FALSE WHERE primary_email = 'former-admin@example.com';
```

---

## Crawler Job Management

### Idempotency Keys

**Feature:** All crawler jobs now have automatic idempotency keys to prevent duplicate runs.

**How It Works:**
- Idempotency key generated from: job type + profile ID + parameters
- Before creating a job, system checks for existing queued/running job with same key
- If found, returns existing job instead of creating duplicate

**Benefits:**
- Prevents duplicate crawls from UI double-clicks
- Prevents duplicate crawls from API retries
- Reduces wasted resources and confusion

**Implementation:**
Use the centralized `createCrawlerJob` utility instead of direct SQL inserts:

```javascript
import { createCrawlerJob } from '../services/crawlerJobCreation.js'

const result = await createCrawlerJob(db, {
  type: 'local',
  profileId: 'profile-123',
  parameters: { zip: '12345' },
  requestedBy: userId,
})

if (result.existing) {
  console.log('Job already exists:', result.jobId)
} else {
  console.log('New job created:', result.jobId)
}
```

### Profile Context Snapshots

**Feature:** Crawler jobs capture a snapshot of profile data at dispatch time.

**Benefits:**
- Deterministic execution - crawlers operate on immutable data
- Profile changes don't affect running jobs
- Failed jobs can be retried with exact same context

**Implementation:**
The `createCrawlerJob` utility automatically builds and stores snapshots when `buildSnapshot: true` (default).

### Dead Letter Queue

**Feature:** All crawler job failures are logged to a durable dead letter queue for diagnosis and recovery.

**Schema:**
```sql
CREATE TABLE dead_letter_queue (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  job_type TEXT NOT NULL,
  profile_id TEXT,
  error_message TEXT NOT NULL,
  error_stack TEXT,
  severity TEXT, -- low, medium, high, critical
  retry_count INTEGER DEFAULT 0,
  resolved BOOLEAN DEFAULT FALSE,
  ...
);
```

**API Endpoints:**
```bash
# Get all failure statistics
GET /api/admin/dead-letter-queue

# Get failures for specific job type
GET /api/admin/dead-letter-queue?jobType=local&limit=50

# Mark failure as resolved
POST /api/admin/dead-letter-queue/:id/resolve
{
  "notes": "Fixed by updating profile data"
}
```

**Automatic Logging:**
All failures in `crawlerDispatcher.js` are automatically logged to the dead letter queue with:
- Full error details (message, stack, code)
- Job state snapshot (parameters, profile context)
- Auto-classified severity (critical, high, medium, low)

---

## Database Write Validation

### Centralized Validation

**Feature:** All high-risk database writes now use centralized validation before execution.

**Available Validators:**
```javascript
import {
  validateJobStatus,
  validateGrantStatus,
  validateApplicantType,
  validateDocumentType,
  validateDate,
  validateDatetime,
  validateStateCode,
  validateZipCode,
  validateEmail,
  validateUrl,
  validateUuid,
  validateForeignKey,
  validatePositiveInteger,
  validatePositiveNumber,
  validateJson,
  validateBoolean,
} from '../utils/dbValidation.js'
```

**Usage Example:**
```javascript
// Before insert
const normalizedStatus = validateJobStatus(status) // throws if invalid
const normalizedZip = validateZipCode(zip) // throws if invalid
const normalizedState = validateStateCode(state) // throws if invalid

await db.prepare('INSERT INTO crawler_jobs (status, ...) VALUES (?, ...)')
  .run(normalizedStatus, ...)
```

**Benefits:**
- Prevents constraint violations
- Provides clear error messages
- Normalizes data (e.g., uppercase state codes, lowercase emails)
- Centralized business rules

---

## Profile Access Control

### Access Requirements

**Rule:** All profiles MUST have either:
1. `user_id` - Owner user ID
2. `profile_emails` entries - Additional email-based access

**Admin Bypass:**
Admins (`req.ctx.isAdmin = true`) can access any profile regardless of ownership.

**Access Check Hierarchy:**
1. Admin? → Allow (no further checks)
2. Profile has `user_id` matching `req.ctx.userId`? → Allow
3. User email in `profile_emails` for profile? → Allow
4. Legacy token has `profileId` claim? → Allow (backward compatibility)
5. Otherwise → Deny (403 Forbidden)

**Implementation:**
```javascript
// In routes
if (!(await ensureProfileAccess(req, res, profileId))) {
  return // 403 already sent
}

// In middleware
router.param('id', ensureProfileAccessByEmail)
```

---

## Anya Code Fixing

### GitHub Action Integration

**Workflow:** `.github/workflows/anya-code-fix-pr.yml`

**Purpose:** Creates pull requests from Anya-generated unified diffs.

**Usage:**
1. Anya analyzes code and generates unified diff patch
2. Trigger workflow with patch content, branch name, PR title/description
3. Workflow applies patch, creates branch, opens PR

**Trigger:**
```bash
# Via GitHub UI
Actions → Anya Code Fix PR Creator → Run workflow

# Via API
POST /repos/:owner/:repo/actions/workflows/anya-code-fix-pr.yml/dispatches
{
  "ref": "main",
  "inputs": {
    "patch_content": "diff --git a/...",
    "branch_name": "anya/fix-issue-123",
    "pr_title": "Fix: Handle null values in profile parser",
    "pr_description": "Anya detected and fixed null pointer issues...",
    "base_branch": "main"
  }
}
```

**Safety:**
- Validates patch is unified diff format
- Checks patch can be applied cleanly
- Verifies changes were made
- Auto-labels PRs as "anya-generated" and "automated"

---

## Migration Guide

### From Previous Version

1. **Set AUTH_JWT_SECRET:**
   ```bash
   # Generate secret
   openssl rand -base64 48
   
   # Add to environment
   AUTH_JWT_SECRET="<generated-secret>"
   ```

2. **Run Database Migrations:**
   ```bash
   # Migration 006 adds dead_letter_queue table
   # Migrations run automatically on startup if DB_AUTO_MIGRATE=true
   
   # Or run manually
   node backend/db/migrations/run-migration.js 006_add_dead_letter_queue.sql
   ```

3. **Verify Admin Users:**
   ```sql
   -- Check which users have admin status
   SELECT id, primary_email, is_admin FROM users WHERE is_admin = TRUE;
   
   -- Grant admin if needed
   UPDATE users SET is_admin = TRUE WHERE primary_email = 'admin@example.com';
   ```

4. **Update Crawler Job Creation Code:**
   Replace direct SQL inserts with `createCrawlerJob`:
   ```javascript
   // OLD (don't use)
   await db.prepare('INSERT INTO crawler_jobs (...) VALUES (...)').run(...)
   
   // NEW (use this)
   const result = await createCrawlerJob(db, { type, profileId, parameters })
   ```

---

## Testing

### Run Production Hardening Tests

```bash
# Run all tests
npm test

# Run specific test suite
node tests/unit/production-hardening.test.mjs
```

### Test Coverage

Tests verify:
- JWT secret fail-fast behavior
- Admin authorization via DB
- Crawler idempotency key generation
- Duplicate job prevention
- Dead letter queue logging
- DB validation functions
- Profile access control
- Profile context building

---

## Monitoring & Operations

### Health Checks

**Admin Dashboard:**
```
GET /api/admin/dead-letter-queue
```
Returns failure statistics by job type.

**Metrics to Monitor:**
- Unresolved failures in dead letter queue
- Critical severity failures
- High retry counts
- Pattern of failures by job type

### Troubleshooting

**Symptom:** Application fails to start with JWT secret error

**Solution:**
```bash
# Generate and set AUTH_JWT_SECRET
export AUTH_JWT_SECRET=$(openssl rand -base64 48)
```

**Symptom:** User reports "Not authorized" despite being admin

**Solution:**
```sql
-- Verify admin status in database
SELECT id, primary_email, is_admin FROM users WHERE primary_email = 'user@example.com';

-- Grant admin if missing
UPDATE users SET is_admin = TRUE WHERE primary_email = 'user@example.com';
```

**Symptom:** Duplicate crawler jobs being created

**Solution:**
Check if code is using `createCrawlerJob` utility or direct SQL inserts. Update to use utility.

**Symptom:** Crawler failures not showing in dead letter queue

**Solution:**
Ensure `crawlerDispatcher.js` is imported correctly and failures are being caught.

---

## Security Considerations

1. **JWT Secrets:**
   - Never commit secrets to version control
   - Rotate secrets periodically (requires session invalidation)
   - Use secrets manager (e.g., Railway secrets, AWS Secrets Manager)

2. **Admin Access:**
   - Audit admin users regularly
   - Remove admin access when no longer needed
   - Log admin actions for compliance

3. **Database Validation:**
   - Always validate before writes
   - Never trust client input
   - Use parameterized queries (already enforced)

4. **Dead Letter Queue:**
   - Contains sensitive error details - restrict access to admins
   - Clean up resolved entries periodically
   - Monitor for patterns indicating attacks

---

## Support

For issues or questions:
- Check dead letter queue for failure details
- Review application logs for error messages
- Consult VERIFICATION.md for implementation details
- Contact development team
