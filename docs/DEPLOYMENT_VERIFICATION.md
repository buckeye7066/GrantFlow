# Deployment Verification: Fix for "Failed to add grant to pipeline"

**Commit SHA**: See PR commit history  
**Branch**: copilot/fix-grant-pipeline-error-again  
**Date**: 2026-02-01

## Summary of Fixes

This PR fixes critical 500 errors in the `/api/grants/from-opportunity` endpoint that were causing "Failed to add grant to pipeline" errors in production.

### Issues Fixed

1. **Foreign Key Constraint Violation**: When both `opportunity_id` and `opportunity_data` were provided, the endpoint would attempt to insert a non-existent `opportunity_id` into the database, causing a FK constraint failure → 500 error.

2. **Confusing Error Messages**: When a non-existent `profile_id` was provided, the error message was "You must specify either a profile_id or organization_id" even though the user DID provide a profile_id.

3. **Missing Telemetry**: Limited visibility into where failures occurred and what inputs caused them.

## Pre-Deployment Verification

### 1. Run Tests Locally

```bash
# Run unit tests
npm run unit

# Run the comprehensive integration test
ADMIN_TOKEN=test-admin-token node tests/manual/test-from-opportunity-comprehensive.mjs

# Run the verification script
PROFILE_ID=profile-demo-tennessee-stem-student ADMIN_TOKEN=test-admin-token \
  node scripts/verify-add-to-pipeline-from-opportunity.mjs http://localhost:8080
```

**Expected Result**: All tests should pass.

### 2. Run Linter and Build

```bash
# Lint
npm run lint

# Build
npm run build
```

**Expected Result**: No errors.

## Deployment Steps

1. **Merge the PR** to the main branch
2. **Deploy to staging** (if available)
3. **Verify in staging** using the verification script
4. **Deploy to production**
5. **Verify in production** (see below)

## Post-Deployment Verification

### Automated Verification

Run the verification script against production:

```bash
PROFILE_ID=<your-test-profile-id> \
ADMIN_TOKEN=<your-admin-token> \
node scripts/verify-add-to-pipeline-from-opportunity.mjs https://your-production-domain.com
```

**Expected Output**:
```
✓ Valid opportunity_data: 201 <grant-id>
✓ FK constraint fix (opp_id + fallback): 201 <grant-id>
✓ Non-existent profile error: 404 profile_not_found
✓ Validation error handling: 400 missing_required_field

[verify] ✓ All 4 tests passed
```

### Manual Verification

1. **Test Adding a Grant from Discovery Page**:
   - Navigate to Discover Grants page
   - Find any opportunity
   - Click "Add to Pipeline"
   - **Expected**: Grant is added successfully (no 500 error)

2. **Test Adding a Grant from Funding Opportunities Page**:
   - Navigate to Funding Opportunities
   - Select a profile
   - Click "Add to Pipeline" on any opportunity
   - **Expected**: Grant is added successfully (no 500 error)

3. **Test Error Handling**:
   - Try adding the same grant twice
   - **Expected**: See "Grant already in pipeline" message (not 500 error)

### Monitoring

After deployment, monitor the following logs for 24-48 hours:

1. **Success Logs** (should see these for every successful add):
```
[grants/from-opportunity] success {
  requestId: '...',
  status: 201,
  grant_id: '...',
  already_exists: false,
  profile_id: '...',
  organization_id: '...',
  opportunity_source: 'database' | 'direct_data',
  opportunity_title: '...'
}
```

2. **Error Logs** (check for any unexpected patterns):
```
[grants/from-opportunity] failed {
  requestId: '...',
  error: '...',
  ...
}
```

3. **Metrics to Watch**:
   - **500 error rate** for `/api/grants/from-opportunity` → Should drop to near zero
   - **400/404 error rate** → May increase slightly (this is good - proper validation)
   - **201/200 success rate** → Should remain high or increase

## Rollback Plan

If issues are detected:

1. **Immediate**: Revert the PR merge
2. **Database**: No schema changes were made, so no DB rollback needed
3. **Frontend**: Frontend changes are backward compatible
4. **Investigate**: Review logs to identify the specific failure case
5. **Fix**: Address the issue and re-deploy

## Known Limitations

- The fix does not address authentication/authorization issues (401/403 errors)
- The fix does not address network/connectivity issues
- Some pre-existing test failures remain (unrelated to this fix)

## Success Criteria

✅ **Before this fix**:
- Users reported "Failed to add grant to pipeline" errors
- Backend returned 500 errors for certain payloads
- Logs showed FK constraint violations

✅ **After this fix**:
- No more 500 errors for the tested scenarios
- Clear, actionable error messages (404, 400)
- Comprehensive logging for debugging
- All verification tests pass

## Contact

For issues or questions about this deployment:
- Check logs for `[grants/from-opportunity]` entries
- Review `requestId` in error responses to trace specific failures
- Consult this PR: copilot/fix-grant-pipeline-error-again

---

**Verification Date**: _____________  
**Verified By**: _____________  
**Production Commit SHA**: _____________  
**Status**: ⬜ Success ⬜ Issues Found (describe below)

**Notes**:
