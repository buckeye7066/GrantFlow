# Anya Enhanced Capabilities Documentation

## Overview
Anya, the AI assistant within GrantFlow, has been enhanced with powerful autonomous capabilities to handle complex tasks including code crawling, function testing, and grant crawler management.

## Enhanced Tools and Capabilities

### 1. Autonomous Code Crawling and Fixing
**Tool:** `admin.anya.runAutonomous`

#### Features:
- Deep scans entire codebase for errors and anti-patterns
- Automatically fixes common issues:
  - Comments out console.log statements in production code
  - Adds error handling to empty catch blocks
  - Tracks TODO/FIXME comments for later review
- Detects critical security issues:
  - Hardcoded API keys or secrets
  - SQL injection vulnerabilities
  - Unhandled promise rejections
  - Deep property access without optional chaining

#### Usage Example:
```javascript
// Anya can run this autonomously
{
  tool: "admin.anya.runAutonomous",
  params: {
    directory: "backend",        // Or scan entire repo
    fixConsoleLog: true,         // Auto-fix console.logs
    fixEmptyCatch: true,         // Add error handling
    maxFileChanges: 20,          // Safety limit
    dryRun: false               // Actually apply fixes
  }
}
```

### 2. Enhanced Crawler Management
**Tool:** `admin.anya.runCrawlers`

#### Features:
- Runs crawlers for all profiles or specific profiles
- **Automatically saves ALL opportunities to global page** (new!)
- **Filters opportunities with 80%+ match to profile pipelines** (new!)
- Handles retry logic for failed crawler jobs
- Monitors job completion with timeout protection

#### Match Score Calculation:
- **Location Match:** 30 points for exact state match, 15 for nationwide
- **Category Alignment:** Up to 40 points based on category overlap
- **Organization Type:** 20 points for eligibility match
- **Special Attributes:** 10 points for veteran/disability services

#### Usage Example:
```javascript
// Anya runs crawlers with intelligent filtering
{
  tool: "admin.anya.runCrawlers",
  params: {
    profileIds: null,            // Run for all active profiles
    crawlerTypes: ["local", "scholarship", "comprehensive"],
    matchThreshold: 80,          // Only save 80%+ matches to profiles
    saveAllToGlobal: true,       // Save everything globally
    waitForCompletion: true,     // Monitor until done
    maxRetries: 3               // Retry failed jobs
  }
}
```

### 3. Comprehensive Function Testing
**Tool:** `admin.anya.testFunctions`

#### Features:
- Tests all API endpoints systematically
- Expanded test suites covering:
  - Authentication flows
  - Profile management
  - Opportunity discovery
  - Crawler operations
  - AI features
  - Anya's own capabilities
- Validates database connectivity
- Checks authorization requirements

#### Test Suites:
1. **Health Checks:** Server and database status
2. **Authentication:** Email codes, sessions, token refresh
3. **Profiles:** List, current, stats endpoints
4. **Opportunities:** Search, categories, listings
5. **Crawlers:** Job management and status
6. **Anya:** Tools, chat, status checks
7. **AI Features:** OpenAI connection, grant matching

#### Usage Example:
```javascript
// Anya tests all functions
{
  tool: "admin.anya.testFunctions",
  params: {
    testSuites: ["auth", "profiles", "opportunities", "crawlers"],
    fixErrors: true,             // Attempt to fix found issues
    dryRun: false               // Apply fixes
  }
}
```

## Autonomous Operation Workflow

### Phase 1: Code Quality
1. Anya scans entire codebase for errors
2. Identifies patterns: console.logs, empty catches, TODOs
3. Applies safe automatic fixes
4. Creates backup before modifications
5. Logs all changes for audit

### Phase 2: Function Testing
1. Tests all API endpoints
2. Validates authentication flows
3. Checks database operations
4. Reports failing endpoints
5. Suggests fixes for common issues

### Phase 3: Crawler Execution
1. Runs crawlers for each profile
2. Calculates match scores for opportunities
3. Saves high matches (80%+) to profile pipelines
4. Saves ALL opportunities to global page
5. Handles retries for failed jobs

## Match Score Algorithm

```javascript
// How Anya calculates opportunity-profile match
function calculateMatchScore(opportunity, profile) {
  let score = 0;
  
  // Location (30%)
  if (opportunity.state === profile.state) score += 30;
  else if (opportunity.nationwide) score += 15;
  
  // Categories (40%)
  const categoryMatches = findCategoryOverlap(
    opportunity.categories,
    profile.categories
  );
  score += Math.min(40, categoryMatches * 10);
  
  // Organization Type (20%)
  if (opportunityAcceptsOrgType(opportunity, profile)) {
    score += 20;
  }
  
  // Special Attributes (10%)
  if (profile.serves_veterans && opportunity.veterans) score += 5;
  if (profile.serves_disabled && opportunity.disability) score += 5;
  
  return score; // 0-100 scale
}
```

## Audit and Logging

All autonomous operations create detailed audit logs:
- **Location:** `backend/data/audit/`
- **Files:**
  - `autonomous-crawler.log` - Code crawling operations
  - `autonomous-crawlers.log` - Grant crawler operations  
  - `autonomous-function-tests.log` - API testing results

## Safety Features

1. **Backup Creation:** All file modifications create backups
2. **Dry Run Mode:** Test changes without applying
3. **Rate Limiting:** Prevents overwhelming the system
4. **Change Limits:** Maximum file modification limits
5. **Audit Trail:** Complete log of all operations

## API Keys Required

For full functionality, ensure these environment variables are set:
- `ANTHROPIC_API_KEY` - For Anya's AI capabilities
- `OPENAI_API_KEY` - For grant matching and proposals
- `RESEND_API_KEY` - For email notifications (optional)

## How to Give Anya Access

Anya requires admin privileges to run autonomous operations. Users with admin role can invoke these tools through:

1. **Direct API:** POST to `/api/anya/chat` with admin token
2. **UI Interface:** Admin Tools section in the app
3. **Script Execution:** Run `scripts/run-anya-autonomous.mjs`

## Example Commands for Anya

```javascript
// Full autonomous operation
"Anya, run a complete system check: scan code, test all functions, and run crawlers for all profiles"

// Targeted code fix
"Anya, find and fix all console.log statements in the backend"

// Crawler with filtering
"Anya, run comprehensive crawlers for all profiles, save matches above 80% to profiles and all results globally"

// Function testing
"Anya, test all API endpoints and report any failures"
```

## Monitoring Progress

Check operation status:
```javascript
{
  tool: "admin.anya.getStatus",
  params: {
    operationType: "all"  // or "code", "crawlers", "functions"
  }
}
```

## Best Practices

1. **Start with Dry Run:** Test operations with `dryRun: true`
2. **Monitor Logs:** Check audit logs for detailed results
3. **Set Appropriate Limits:** Use `maxFileChanges` to prevent over-modification
4. **Review Changes:** Examine backups before committing
5. **Schedule Regular Runs:** Set up cron jobs for periodic maintenance

## Troubleshooting

### Common Issues:
1. **"API key not configured"** - Set ANTHROPIC_API_KEY environment variable
2. **"Database unavailable"** - Ensure SQLite database is accessible
3. **"Admin privileges required"** - User must have admin role
4. **"Timeout reached"** - Increase timeoutMinutes for large operations

### Recovery:
- All operations create backups in `backend/backups/`
- Audit logs contain complete operation history
- Failed jobs can be retried with `admin.crawler.retry`

## Future Enhancements

Planned improvements:
- [ ] Real-time progress streaming
- [ ] Automatic error recovery strategies  
- [ ] Machine learning for better match scoring
- [ ] Integration with CI/CD pipelines
- [ ] Scheduled autonomous maintenance