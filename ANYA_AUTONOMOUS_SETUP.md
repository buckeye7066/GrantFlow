# Anya Autonomous Operations - Setup Guide

## Quick Start

Anya's autonomous operations are **disabled by default**. You can control when and how Anya runs autonomous tasks through environment variables.

## Configuration Options

### 1. **Enable on Server Startup** (Runs once when server starts)
```env
ANYA_AUTONOMOUS_ENABLED=true
ANYA_RUN_ON_STARTUP=true
```

### 2. **Enable on Admin Login** (Runs when an admin user logs in)
```env
ANYA_AUTONOMOUS_ENABLED=true
ANYA_RUN_ON_ADMIN_LOGIN=true
```

### 3. **Enable Both** (Runs on startup AND admin login)
```env
ANYA_AUTONOMOUS_ENABLED=true
ANYA_RUN_ON_STARTUP=true
ANYA_RUN_ON_ADMIN_LOGIN=true
```

### 4. **Manual Only** (Default - must be triggered manually)
```env
ANYA_AUTONOMOUS_ENABLED=false  # or omit these variables
```

## What Happens When Enabled

When Anya runs autonomous operations, she will:

1. **Code Crawl & Fix** (Phase 1)
   - Scan entire codebase for errors and anti-patterns
   - Fix console.log statements (comment them out)
   - Fix empty catch blocks (add error handling)
   - Detect security issues (hardcoded secrets, SQL injection)
   - Track TODO/FIXME comments

2. **Function Testing** (Phase 2)
   - Test all API endpoints
   - Validate authentication flows
   - Check database operations
   - Report failing endpoints

3. **Smart Crawler Execution** (Phase 3)
   - Run crawlers for all active profiles
   - Calculate match scores for each opportunity
   - Save opportunities with 80%+ match to profile pipelines
   - Save ALL opportunities to global page
   - Handle retries for failed jobs

## Customization Options

### Control Which Operations Run
```env
ANYA_CODE_CRAWL=true        # Enable code scanning
ANYA_FUNCTION_TESTS=true    # Enable function testing
ANYA_CRAWLERS=true          # Enable grant crawlers
```

### Fine-tune Code Fixes
```env
ANYA_FIX_CONSOLE=true       # Fix console.log statements
ANYA_FIX_EMPTY_CATCH=true   # Fix empty catch blocks
ANYA_MAX_FILE_CHANGES=20    # Limit files modified per run
```

### Configure Crawler Behavior
```env
ANYA_MATCH_THRESHOLD=80     # Min % match for profile pipeline (0-100)
ANYA_SAVE_GLOBAL=true       # Save all opportunities globally
ANYA_WAIT_COMPLETION=false  # Don't wait for completion (async)
```

### Test Mode (Dry Run)
```env
ANYA_DRY_RUN=true           # Preview changes without applying
```

## Monitoring

### Check Logs
Autonomous operations create detailed audit logs in:
- `backend/data/audit/autonomous-scheduler.log` - Overall operations
- `backend/data/audit/autonomous-crawler.log` - Code crawling
- `backend/data/audit/autonomous-crawlers.log` - Grant crawlers
- `backend/data/audit/autonomous-function-tests.log` - API testing

### Example Log Entry
```json
{
  "timestamp": "2024-01-05T10:30:00Z",
  "operation": "batch_complete",
  "status": "success",
  "trigger": "admin_login",
  "operations": {
    "codeCrawl": {
      "status": "completed",
      "files_scanned": 145,
      "files_modified": 12,
      "issues_fixed": 23
    },
    "crawlers": {
      "status": "completed",
      "profiles_processed": 8,
      "jobs_created": 32
    }
  }
}
```

## Performance Considerations

- **Startup Impact**: Operations run 5 seconds after server starts to avoid blocking
- **Background Execution**: Operations run asynchronously, won't block login
- **Resource Usage**: Code scanning and crawlers can be CPU intensive
- **Database Load**: Crawler operations create many database writes

## Recommended Settings

### Development Environment
```env
ANYA_AUTONOMOUS_ENABLED=false   # Keep disabled during development
```

### Staging Environment
```env
ANYA_AUTONOMOUS_ENABLED=true
ANYA_RUN_ON_ADMIN_LOGIN=true   # Test on admin login
ANYA_DRY_RUN=true              # Preview mode
ANYA_MAX_FILE_CHANGES=5        # Conservative limit
```

### Production Environment
```env
ANYA_AUTONOMOUS_ENABLED=true
ANYA_RUN_ON_STARTUP=true       # Run on server restart
ANYA_MATCH_THRESHOLD=80        # High-quality matches only
ANYA_SAVE_GLOBAL=true          # Comprehensive discovery
ANYA_DRY_RUN=false            # Apply fixes
```

## Security Notes

- Only users with `admin` role can trigger manual operations
- All file modifications create backups before changes
- Audit logs track all autonomous operations
- API keys must be properly configured:
  - `ANTHROPIC_API_KEY` - Required for Anya's AI features
  - `OPENAI_API_KEY` - Required for crawlers and matching

## Troubleshooting

### "Autonomous operations disabled"
- Set `ANYA_AUTONOMOUS_ENABLED=true`

### "API key not configured"
- Set `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` in environment

### Operations not running on login
- Verify user has `admin` role
- Check `ANYA_RUN_ON_ADMIN_LOGIN=true`

### Too many files being modified
- Reduce `ANYA_MAX_FILE_CHANGES`
- Enable `ANYA_DRY_RUN=true` for testing

## Manual Trigger via API

Admin users can manually trigger operations:

```bash
curl -X POST http://localhost:8080/api/anya/chat \
  -H "Authorization: Bearer ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Run autonomous operations",
    "tool": "admin.anya.runAutonomous"
  }'
```