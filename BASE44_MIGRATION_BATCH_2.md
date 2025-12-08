# Base44 Migration Batch #2 - Functions Review

**Date**: December 8, 2025  
**Repository**: buckeye7066/GrantFlow  
**Branch**: main  
**Webhook Endpoint**: https://grant-flow-736bafec.base44.app/api/apps/68ef1aa9f941d6a9736bafec/functions/githubWebhook

---

## Overview

This document covers the second batch of 10 functions from the `functions/` directory for Base44 migration and integration review. This batch includes core crawling, processing, and notification functionality.

## Migration Status

### Webhook Integration
- **Endpoint**: `https://grant-flow-736bafec.base44.app/api/apps/68ef1aa9f941d6a9736bafec/functions/githubWebhook`
- **Purpose**: GitHub webhook for staged migration and deployment triggers
- **Test File**: `base44_webhook_test.txt` has been provided for validation

---

## Files in This Batch

### 1. ✅ queueCrawl.js
**Status**: Ready for migration  
**Size**: 68 lines  
**Purpose**: Queue and dispatch crawling tasks to appropriate adapters

**Key Features**:
- Maps source names to crawler adapters (benefits_gov, dsire, grants_gov, irs_990_pf, lee_university)
- Implements retry logic with exponential backoff (3 retries, 1s base delay)
- Uses Base44 SDK v0.7.1
- Safe error handling with structured error codes

**Dependencies**:
- `@base44/sdk@0.7.1`
- `./_shared/safeHandler.js`

**Integration Notes**:
- Invokes other crawler functions via SDK functions.invoke()
- Returns 202 (Accepted) for async operations
- Requires ADAPTER_MAP configuration for supported sources

---

### 2. ⚠️ analyzeGrant.js
**Status**: MISSING/PLACEHOLDER  
**Size**: 14 bytes (contains only "File not found")  
**Action Required**: Confirm with Base44 if this file was deleted or needs to be implemented

**Note**: This appears to be a placeholder file. Please verify if:
- The function was intentionally removed
- The functionality was merged into another function (e.g., `analyze2grant.js` which exists in the repo)
- A new implementation is needed

---

### 3. ✅ generateProgressReport.js
**Status**: Ready for migration  
**Size**: 48 lines  
**Purpose**: Generate progress reports for grants using AI-powered content generation

**Key Features**:
- Creates compliance reports with multiple sections (executive_summary, activities_summary, progress_toward_goals, financial_summary, challenges_and_solutions, next_steps)
- Uses Base44 SDK v0.8.4
- Integrates with LLM for content generation
- Enforces user ownership and security checks

**Dependencies**:
- `@base44/sdk@0.8.4`
- `./_shared/security.js`
- `./_utils/resolveEntityId.js`

**Integration Notes**:
- Queries Grant, Organization, GrantKPI, Expense, and Milestone entities
- Uses Core.InvokeLLM integration
- Creates ComplianceReport entities with status 'draft'
- Includes ownership enforcement via `enforceOwnership()`

---

### 4. ✅ pushToGithub.js
**Status**: Ready for migration  
**Size**: 170 lines  
**Purpose**: Push code/files to GitHub repositories with optional PR creation

**Key Features**:
- Creates blobs, trees, and commits via GitHub API
- Handles empty repositories
- Supports branch creation and pull request generation
- Comprehensive error handling for each GitHub API step

**Dependencies**:
- `@base44/sdk@0.8.4`
- `./_shared/safeHandler.js`
- Requires `GITHUB_TOKEN` environment variable

**Integration Notes**:
- Uses GitHub API v3 with 2022-11-28 API version
- Returns commit SHA, branch name, and commit URL
- PR creation is optional (controlled by `createPR` parameter)
- File format: `{ path: string, content: string }`

**Environment Variables Required**:
- `GITHUB_TOKEN`: GitHub personal access token or app token

---

### 5. ✅ notifyAdminNewMessage.js
**Status**: Ready for migration  
**Size**: 25 lines  
**Purpose**: Send email notifications to admin when new messages arrive

**Key Features**:
- Simple email notification system
- Fetches message details by ID
- Sends formatted email to admin

**Dependencies**:
- `@base44/sdk@0.8.4`

**Integration Notes**:
- Uses Core.SendEmail integration
- Hardcoded admin email: `buckeye7066@gmail.com` (Note: Should be configurable via environment variable for better maintainability)
- Email includes message subject, sender info, type, and content
- Requires Message entity access

---

### 6. ✅ processOpportunity.js
**Status**: Ready for migration  
**Size**: 98 lines  
**Purpose**: Process grant opportunities from external sources and standardize them

**Key Features**:
- Validates incoming grant data with detailed error reporting
- Maps external grant formats to internal schema
- Sensitive field masking in logs (email, phone, ssn, ein, apiKey)
- Comprehensive error codes and structured error responses

**Dependencies**:
- `@base44/sdk@0.7.1`
- `./_shared/safeHandler.js`

**Integration Notes**:
- Expects `rawGrant` with: opportunityId, opportunityTitle, agencyName (optional), description (optional), postDate, closeDate, awardFloor, awardCeiling, categories, eligibleApplicants
- Maps to grants.gov format
- Invokes `processCrawledItem` for final processing
- Returns structured error responses with error codes

---

### 7. ✅ enqueueGrant.js
**Status**: Ready for migration  
**Size**: 45 lines  
**Purpose**: Manage processing queue for grant analysis jobs

**Key Features**:
- Prevents duplicate queue entries (checks pending and running status)
- Supports bulk enqueueing via `grant_ids` array
- Provides queue statistics via `action: 'stats'`
- Test mode support via `_selfTest` flag

**Dependencies**:
- `@base44/sdk@0.8.4`

**Integration Notes**:
- Uses ProcessingQueue entity with fields: profile_id, grant_id, status, attempts
- Returns different responses for: already_queued, already_running, created
- Bulk operation returns queued/skipped/total counts
- Stats action returns pending and running counts

---

### 8. ✅ crawlGrantsGov.js
**Status**: Ready for migration  
**Size**: 91 lines  
**Purpose**: Crawl federal grants from Grants.gov using AI-powered extraction

**Key Features**:
- Uses LLM with internet context to extract grant data
- Retry logic with exponential backoff (3 retries, 2s base delay)
- Batch processing with configurable limits (5 per batch, 1s delay)
- Crawler timeout protection (40s max)
- Structured JSON schema for extraction

**Dependencies**:
- `@base44/sdk@0.8.4`
- `./_shared/safeHandler.js`

**Integration Notes**:
- Creates CrawlLog entity for tracking
- Extracts: opportunityNumber, title, agencyName, postedDate, closeDate, awardCeiling, awardFloor, description, eligibleApplicants, fundingCategory
- Maps to standardized format and invokes `processCrawledItem`
- Updates CrawlLog with status (started/completed/failed) and record counts
- Processes up to 20 grants per run

---

### 9. ✅ processCrawledItem.js
**Status**: Ready for migration  
**Size**: 79 lines  
**Purpose**: Process and persist crawled funding opportunities with deduplication

**Key Features**:
- Validates required fields (source, source_id, title)
- Skips expired opportunities (unless deadline is 'rolling'/'ongoing'/'open')
- Deduplication by source + source_id
- Creates or updates FundingOpportunity entities
- Description truncation and AI summary generation

**Dependencies**:
- `@base44/sdk@0.8.4`
- `./_shared/safeHandler.js`

**Integration Notes**:
- Filters existing opportunities to prevent duplicates
- Updates lastCrawled timestamp on updates
- Returns status: created/updated/skipped with reason
- Test mode support via `test_mode` flag
- Handles both description_raw and descriptionMd fields

---

### 10. ✅ crawlDSIRE.js
**Status**: Ready for migration  
**Size**: 57 lines  
**Purpose**: Crawl DSIRE (Database of State Incentives for Renewables & Efficiency)

**Key Features**:
- Sample data approach (uses predefined opportunities)
- Processes renewable energy and tax credit programs
- Retry logic with exponential backoff
- Comprehensive error tracking per item

**Dependencies**:
- `@base44/sdk@0.8.4`
- `./_shared/safeHandler.js`

**Integration Notes**:
- Creates CrawlLog for tracking
- Sample opportunities include: TVA Green Power, Residential Clean Energy Credit, Tennessee Solar Rebate, Energy Efficient Home Credit, Georgia Solar Tax Credit
- Each item includes: source_id, url, title, sponsor, description_raw, funding_type, regions, categories
- Invokes `processCrawledItem` for each opportunity
- Updates CrawlLog with found/added counts and error list
- Returns status: completed with processing statistics

---

## Shared Dependencies

All functions in this batch rely on shared modules:

### Shared Modules
- `./_shared/safeHandler.js` - Safe server wrapper with error handling
- `./_shared/security.js` - Authentication and authorization utilities
- `./_utils/resolveEntityId.js` - Entity ID resolution utilities

### Entity Types Used
- `FundingOpportunity` - Crawled funding sources
- `CrawlLog` - Crawler execution tracking
- `ProcessingQueue` - Grant processing queue
- `Grant` - Grant records
- `Organization` - Organization entities
- `ComplianceReport` - Progress reports
- `Message` - User messages
- `GrantKPI`, `Expense`, `Milestone` - Grant-related metrics

### SDK Versions
- v0.7.1: queueCrawl.js, processOpportunity.js
- v0.8.4: All other files

**Migration Consideration**: Verify SDK version compatibility and consider standardizing on v0.8.4

---

## Integration Workflow

```
queueCrawl.js
    ↓ (invokes)
crawlGrantsGov.js / crawlDSIRE.js
    ↓ (for each item)
processCrawledItem.js
    ↓ (creates/updates)
FundingOpportunity Entity
    ↓ (optionally)
enqueueGrant.js
    ↓ (queues)
ProcessingQueue Entity
```

---

## Security Considerations

1. **Authentication**: All functions verify user authentication via Base44 SDK
2. **Authorization**: Ownership enforcement in sensitive operations (generateProgressReport.js)
3. **Data Masking**: Sensitive fields logged with masking (processOpportunity.js)
4. **Input Validation**: All functions validate request body and required fields
5. **Service Role**: Crawler functions use `asServiceRole` for elevated permissions

---

## Environment Variables Required

- `GITHUB_TOKEN` - Required for pushToGithub.js (GitHub API access)

---

## Testing Recommendations for Base44

1. **queueCrawl.js**: Test with each adapter type, verify retry logic
2. **analyzeGrant.js**: ⚠️ Determine implementation status before testing
3. **generateProgressReport.js**: Test report generation with various section combinations
4. **pushToGithub.js**: Test with empty repos, existing repos, PR creation
5. **notifyAdminNewMessage.js**: Verify email delivery to admin
6. **processOpportunity.js**: Test validation errors, data mapping accuracy
7. **enqueueGrant.js**: Test bulk operations, duplicate prevention, stats endpoint
8. **crawlGrantsGov.js**: Verify LLM extraction accuracy, timeout handling
9. **processCrawledItem.js**: Test deduplication, expiration checking
10. **crawlDSIRE.js**: Verify sample data processing, error handling

---

## Migration Checklist for Base44 Team

- [ ] Review all function code for compatibility
- [ ] Verify SDK version requirements (consider upgrade to v0.8.4 for consistency)
- [ ] Confirm environment variable setup (GITHUB_TOKEN)
- [ ] Determine status of analyzeGrant.js - implement or remove
- [ ] Test webhook integration with provided endpoint
- [ ] Validate entity schema compatibility
- [ ] Test integration workflow end-to-end
- [ ] Review security implementation
- [ ] Verify shared module availability
- [ ] Confirm email integration for notifications
- [ ] Set up monitoring for crawler functions
- [ ] Test GitHub API integration with appropriate tokens

---

## Questions for Base44 Team

1. **analyzeGrant.js**: Should this file be implemented, or has its functionality been merged elsewhere?
2. **SDK Versions**: Should we standardize all functions to v0.8.4?
3. **Webhook Testing**: Has the webhook endpoint been tested with the test file?
4. **Staged Migration**: What is the deployment strategy for these functions?
5. **Monitoring**: What logging/monitoring should be configured for production?
6. **Rate Limiting**: Are there rate limits we should implement for external API calls?

---

## Next Steps

1. Base44 team reviews this documentation
2. Address questions about analyzeGrant.js
3. Base44 provides integration feedback
4. Resolve any compatibility issues
5. Prepare for next batch of functions

---

## Contact

For questions or issues with this migration batch, please contact the GrantFlow team or respond to the PR associated with this documentation.

**Repository**: https://github.com/buckeye7066/GrantFlow  
**Migration Branch**: copilot/send-files-for-migration
