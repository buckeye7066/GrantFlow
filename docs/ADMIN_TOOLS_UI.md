# Anya Admin Tools - UI Implementation

## Overview
This document describes the admin tools UI implementation for Anya, GrantFlow's AI copilot.

## Admin User Experience

### 1. Admin Badge
When an admin user accesses Anya, they see a purple "ADMIN" badge next to the Anya title:

```
┌─────────────────────────────────────────────────────────────┐
│  Anya, your GrantFlow copilot [🛡️ ADMIN]                    │
│  Ask about grant matches, automation jobs, or request code  │
│  assistance. All actions stay within this profile.          │
└─────────────────────────────────────────────────────────────┘
```

### 2. Admin Tools Button
An additional "Admin Tools" button appears in the header (purple-themed):

```
┌──────────────────────────────────────────────────────────────┐
│ [Grant insights] [Code search] [🔧 Admin Tools]              │
└──────────────────────────────────────────────────────────────┘
```

### 3. Admin Tools Dialog
Clicking "Admin Tools" opens a categorized dialog showing all 15 admin-only tools:

```
╔══════════════════════════════════════════════════════════════╗
║ 🛡️ Admin Tools                                               ║
╠══════════════════════════════════════════════════════════════╣
║ Advanced diagnostic and management tools for administrators. ║
║ Use with caution.                                            ║
╠══════════════════════════════════════════════════════════════╣
║                                                               ║
║ 💻 Code Analysis                                             ║
║ ┌──────────────────────────────────────────────────────────┐ ║
║ │ admin.code.crawl                                         │ ║
║ │ Deep scan the codebase for patterns, potential errors,  │ ║
║ │ and anti-patterns. Admin only.                           │ ║
║ └──────────────────────────────────────────────────────────┘ ║
║ ┌──────────────────────────────────────────────────────────┐ ║
║ │ admin.code.lint                                          │ ║
║ │ Run ESLint-style checks and report issues. Admin only.  │ ║
║ └──────────────────────────────────────────────────────────┘ ║
║ ┌──────────────────────────────────────────────────────────┐ ║
║ │ admin.code.analyze                                       │ ║
║ │ Analyze a specific file for issues and suggest fixes.   │ ║
║ └──────────────────────────────────────────────────────────┘ ║
║ ┌──────────────────────────────────────────────────────────┐ ║
║ │ admin.code.edit                                          │ ║
║ │ Propose edits to a specific file (shows diff, does not  │ ║
║ │ auto-save). Admin only.                                  │ ║
║ └──────────────────────────────────────────────────────────┘ ║
║                                                               ║
║ 📊 Crawler Management                                        ║
║ ┌──────────────────────────────────────────────────────────┐ ║
║ │ admin.crawler.list                                       │ ║
║ │ List all crawler jobs with their status. Admin only.    │ ║
║ └──────────────────────────────────────────────────────────┘ ║
║ ┌──────────────────────────────────────────────────────────┐ ║
║ │ admin.crawler.run                                        │ ║
║ │ Trigger any crawler type with custom parameters.        │ ║
║ └──────────────────────────────────────────────────────────┘ ║
║ ┌──────────────────────────────────────────────────────────┐ ║
║ │ admin.crawler.check                                      │ ║
║ │ Validate crawler outputs and check for errors.          │ ║
║ └──────────────────────────────────────────────────────────┘ ║
║ ┌──────────────────────────────────────────────────────────┐ ║
║ │ admin.crawler.retry                                      │ ║
║ │ Retry a failed crawler job. Admin only.                 │ ║
║ └──────────────────────────────────────────────────────────┘ ║
║ ┌──────────────────────────────────────────────────────────┐ ║
║ │ admin.crawler.cancel                                     │ ║
║ │ Cancel a running crawler job. Admin only.               │ ║
║ └──────────────────────────────────────────────────────────┘ ║
║                                                               ║
║ 🗄️ Database & Diagnostics                                   ║
║ ┌──────────────────────────────────────────────────────────┐ ║
║ │ admin.db.query                                           │ ║
║ │ Run read-only SQL queries for diagnostics (SELECT only).│ ║
║ └──────────────────────────────────────────────────────────┘ ║
║ ┌──────────────────────────────────────────────────────────┐ ║
║ │ admin.db.stats                                           │ ║
║ │ Get database health statistics. Admin only.             │ ║
║ └──────────────────────────────────────────────────────────┘ ║
║                                                               ║
║ 🏥 Health & Monitoring                                       ║
║ ┌──────────────────────────────────────────────────────────┐ ║
║ │ admin.health.check                                       │ ║
║ │ Full system health report. Admin only.                  │ ║
║ └──────────────────────────────────────────────────────────┘ ║
║ ┌──────────────────────────────────────────────────────────┐ ║
║ │ admin.health.logs                                        │ ║
║ │ Get recent error/warning logs. Admin only.              │ ║
║ └──────────────────────────────────────────────────────────┘ ║
║                                                               ║
║ 🔧 Function Testing                                          ║
║ ┌──────────────────────────────────────────────────────────┐ ║
║ │ admin.functions.test                                     │ ║
║ │ Execute a backend endpoint/function and capture results.│ ║
║ └──────────────────────────────────────────────────────────┘ ║
║ ┌──────────────────────────────────────────────────────────┐ ║
║ │ admin.functions.diagnose                                 │ ║
║ │ Run a function with detailed error tracing.             │ ║
║ └──────────────────────────────────────────────────────────┘ ║
║                                                               ║
║ ℹ️  Ask Anya to use any of these tools by referencing their ║
║    name in your message.                              [Close]║
╚══════════════════════════════════════════════════════════════╝
```

## Usage Examples

### Example 1: Check System Health
Admin asks Anya:
```
User: "Can you run a health check on the system?"
```

Anya invokes `admin.health.check` and responds:
```
Assistant: I've run a system health check. Here's what I found:

✅ Database: Up (SQLite)
✅ Crawlers: Up (0 running jobs)
✅ Environment: Healthy
   - Node version: v20.20.2
   - Uptime: 3,600 seconds
   - Memory: 256 MB

Overall status: Healthy
```

### Example 2: Search for Code Issues
Admin asks Anya:
```
User: "Find all console.log statements in the backend folder"
```

Anya invokes `admin.code.crawl` with parameters:
```json
{
  "pattern": "console\\.log",
  "directory": "backend",
  "includeTests": false
}
```

And responds:
```
Assistant: I found 50 console.log statements in the backend:

1. backend/import-data.js:18 - warning
2. backend/routes/auth.js:45 - warning
3. backend/services/crawlerDispatcher.js:156 - warning
...

These should be replaced with proper logging.
```

### Example 3: List Recent Crawler Jobs
Admin asks Anya:
```
User: "Show me the last 5 failed crawler jobs"
```

Anya invokes `admin.crawler.list`:
```json
{
  "status": "failed",
  "limit": 5
}
```

And responds with job details including errors.

## Security Features

### Access Control
- **Backend**: `invokeTool()` checks `user.role === 'admin'` before allowing execution
- **Frontend**: Admin tools only visible when `user.is_admin === true`
- **API**: `/api/anya/tools` filters tools based on user role

### Audit Logging
Every admin tool invocation is logged:
```javascript
console.log('[anyaToolRegistry] Admin tool invoked:', {
  tool: 'admin.health.check',
  user: 'admin-user-id',
  timestamp: '2026-01-03T05:11:36.277Z',
})
```

### SQL Injection Protection
`admin.db.query` only allows SELECT statements:
- Blocks: INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, TRUNCATE
- Example: `UPDATE users SET ...` → 403 Forbidden

## Visual Design

### Colors
- **Admin Badge**: Purple background (`bg-purple-600`)
- **Admin Tools Button**: Purple border and hover (`border-purple-300`, `bg-purple-50`)
- **Tool Names**: Purple text (`text-purple-600`)

### Icons
- 🛡️ Shield - Admin badge
- 🔧 Wrench - Admin tools button
- 💻 Code - Code analysis category
- 📊 Activity - Crawler management
- 🗄️ Database - Database tools
- 🏥 Activity - Health monitoring
- 🔧 Wrench - Function testing

## Component Structure

```jsx
<AnyaChat profileId={profileId}>
  {/* Header with Admin Badge */}
  {isAdmin && <Badge>ADMIN</Badge>}
  
  {/* Admin Tools Button */}
  {hasAdminTools && (
    <Button onClick={() => setIsAdminToolsOpen(true)}>
      Admin Tools
    </Button>
  )}
  
  {/* Admin Tools Dialog */}
  <Dialog open={isAdminToolsOpen}>
    {/* Code Analysis Section */}
    {adminTools.code.map(tool => <ToolCard />)}
    
    {/* Crawler Management Section */}
    {adminTools.crawler.map(tool => <ToolCard />)}
    
    {/* Database Section */}
    {adminTools.database.map(tool => <ToolCard />)}
    
    {/* Health Section */}
    {adminTools.health.map(tool => <ToolCard />)}
    
    {/* Functions Section */}
    {adminTools.functions.map(tool => <ToolCard />)}
  </Dialog>
</AnyaChat>
```

## Implementation Files

### Backend
- `backend/services/anyaAdminTools.js` - Tool implementations (650 lines)
- `backend/services/anyaToolRegistry.js` - Registration and access control
- `backend/services/anyaOrchestrator.js` - User context handling

### Frontend
- `src/components/anya/AnyaChat.jsx` - Admin UI components
- `src/lib/anyaClient.js` - Admin tool filtering
- `src/stores/authStore.js` - Admin user detection

### Tests
- `scripts/test-admin-tools.mjs` - Unit tests
- `scripts/test-admin-tools-integration.mjs` - Integration tests

## Next Steps for Production

1. **Integrate with real logging system** (Winston, Bunyan, etc.)
2. **Add rate limiting** for admin tool invocations
3. **Create detailed forms** for each admin tool (not just listings)
4. **Add confirmation dialogs** for destructive operations
5. **Implement audit trail** in database for all admin actions
6. **Add admin dashboard** showing recent admin activity
7. **Create admin reports** for crawler performance, system health trends
