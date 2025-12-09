# Logging Best Practices for Base44 Integration

## Overview
This document outlines the logging standards implemented across the GrantFlow codebase for production readiness and Base44 integration.

## Changes Made

### 1. Centralized Logger Utility
- **File**: `functions/_shared/logger.js`
- **Purpose**: Provides environment-aware logging with consistent formatting
- **Features**:
  - Automatic environment detection (Deno/Node.js)
  - Debug/Info logs suppressed in production
  - Warning/Error logs always shown
  - Consistent timestamp and source formatting
  - No sensitive data in logs

### 2. Environment-Aware Logging
All logging now checks the environment before emitting logs:
- **Development**: All log levels (debug, info, warn, error) are shown
- **Production**: Only warnings and errors are shown
- Environment detection works for both Deno (`Deno.env`) and Node.js (`process.env`)

### 3. Log Levels

#### Debug (`logger.debug`)
- **Use for**: Detailed debugging information
- **Production**: Suppressed
- **Example**: Processing counts, intermediate results, operation steps

#### Info (`logger.info`)
- **Use for**: General informational messages
- **Production**: Suppressed
- **Example**: Job started, configuration loaded

#### Warning (`logger.warn`)
- **Use for**: Recoverable issues that should be investigated
- **Production**: Always shown
- **Example**: Retry attempts, fallback behavior, non-critical failures

#### Error (`logger.error`)
- **Use for**: Errors requiring immediate attention
- **Production**: Always shown
- **Example**: Failed operations, data validation errors, system errors

## Files Updated

### Core Infrastructure
1. **functions/_shared/logger.js** - New centralized logger
2. **functions/_shared/safeHandler.js** - Error handling wrapper
3. **functions/_shared/crawlerFramework.js** - Crawler utilities
4. **functions/_shared/atomicLock.js** - Lock management

### Frontend
5. **Layout.js** - Authentication and layout

### Function Endpoints
6. **functions/comprehensiveMatch.js** - Grant matching
7. **functions/crawlBenefitsGov.js** - Benefits.gov crawler
8. **functions/crawlGrantsGov.js** - Grants.gov crawler
9. **functions/crawlDSIRE.js** - DSIRE crawler
10. **functions/processCrawledItem.js** - Item processing
11. **functions/processOpportunity.js** - Opportunity processing
12. **functions/queueCrawl.js** - Crawl queue management
13. **functions/autoMonitor.js** - Queue monitoring
14. **functions/processSingleGrant.js** - Grant processing
15. **functions/pushToGithub.js** - GitHub integration

### Scripts (Unchanged)
- **scripts/repo_scan.js** - Repository scanning utility (intentionally kept verbose for CLI output)
- **scripts/rls_check.js** - RLS policy checker (intentionally kept verbose for CLI output)

## Usage Examples

### Using the Logger

```javascript
import { createLogger } from './_shared/logger.js';

const logger = createLogger('myFunction');

// Debug logs (development only)
logger.debug('Processing started', { count: items.length });

// Info logs (development only)
logger.info('Configuration loaded', { timeout: 5000 });

// Warning logs (always shown)
logger.warn('Retry attempt failed', { attempt: 2 });

// Error logs (always shown)
logger.error('Operation failed', { error: err.message });
```

### Environment Configuration

Set the environment variable to control logging:

```bash
# For production builds
export NODE_ENV=production
export DENO_ENV=production

# For development
export NODE_ENV=development
export DENO_ENV=development
```

## Best Practices

### DO ✅
- Use the centralized logger for all new code
- Log only essential information
- Use appropriate log levels
- Include context in log messages (but not sensitive data)
- Log errors with error messages, not full error objects
- Use debug/info for verbose logs that aren't needed in production

### DON'T ❌
- Don't log sensitive user data (PHI, PII, passwords, tokens)
- Don't log full request/response objects in production
- Don't use console.log/console.debug directly (use logger instead)
- Don't log large data dumps
- Don't log every step of normal operations in production

### Sensitive Data
The following should NEVER be logged:
- User personal information (names, emails, phone numbers)
- Protected Health Information (PHI)
- Authentication tokens or API keys
- Full user profiles
- Raw request/response bodies containing user data
- Database query results with user data

### What to Log
✅ Request IDs for tracing
✅ Error messages (without sensitive context)
✅ Operation counts and statistics
✅ Warning conditions
✅ Critical failures
✅ Performance metrics

## Migration Notes for Base44 Team

### Key Changes
1. All custom `log()` functions have been replaced with the centralized logger
2. Console.log statements converted to appropriate log levels
3. Production builds will be much quieter (only warnings and errors)
4. Development builds maintain full visibility for debugging

### Testing
- Test in development mode: All logs should appear
- Test in production mode: Only warnings and errors should appear
- Verify no sensitive data is logged at any level

### Rollback
If issues arise, the centralized logger can be modified to always log (remove environment checks) without changing calling code.

## Future Enhancements

Consider adding:
- Structured logging (JSON format)
- Log aggregation service integration
- Performance metrics collection
- Request tracing with correlation IDs
- Configurable log levels per module

---

**Last Updated**: December 2024  
**For Questions**: Contact the GrantFlow development team
