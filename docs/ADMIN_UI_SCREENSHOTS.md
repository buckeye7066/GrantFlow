# Admin UI Screenshots (Text Representation)

## Screenshot 1: Regular User View
```
┌─────────────────────────────────────────────────────────────────────┐
│ Anya, your GrantFlow copilot                                        │
│ Ask about grant matches, automation jobs, or request code          │
│ assistance. All actions stay within this profile.                  │
│                                                                     │
│                            [Grant insights] [Code search]           │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│ No messages yet. Ask Anya for help!                                │
│                                                                     │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│ [Ask Anya for help...]                                      [Send] │
└─────────────────────────────────────────────────────────────────────┘

Tools visible: 3 (noop.echo, code.search, grants.summarizeMatches)
```

## Screenshot 2: Admin User View
```
┌─────────────────────────────────────────────────────────────────────┐
│ Anya, your GrantFlow copilot  [🛡️ ADMIN]                           │
│ Ask about grant matches, automation jobs, or request code          │
│ assistance. All actions stay within this profile.                  │
│                                                                     │
│              [Grant insights] [Code search] [🔧 Admin Tools]       │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│ 💬 Welcome! I'm ready to help with admin tasks.                    │
│                                                                     │
│ Try asking me to:                                                   │
│ • "Run a system health check"                                       │
│ • "Find console.log statements in the backend"                      │
│ • "Show me failed crawler jobs"                                     │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│ [Ask Anya for help...]                                      [Send] │
└─────────────────────────────────────────────────────────────────────┘

Tools visible: 18 (3 regular + 15 admin-only)
Admin badge visible: Yes (purple)
Admin tools button: Yes (purple-themed)
```

## Screenshot 3: Admin Tools Dialog
```
╔═══════════════════════════════════════════════════════════════════════╗
║ 🛡️ Admin Tools                                                 [X]   ║
╠═══════════════════════════════════════════════════════════════════════╣
║ Advanced diagnostic and management tools for administrators.         ║
║ Use with caution.                                                     ║
╠═══════════════════════════════════════════════════════════════════════╣
║                                                                       ║
║ 💻 Code Analysis                                                     ║
║ ┌───────────────────────────────────────────────────────────────┐   ║
║ │ admin.code.crawl                                              │   ║
║ │ Deep scan the codebase for patterns, potential errors, and   │   ║
║ │ anti-patterns. Admin only.                                    │   ║
║ └───────────────────────────────────────────────────────────────┘   ║
║ ┌───────────────────────────────────────────────────────────────┐   ║
║ │ admin.code.lint                                               │   ║
║ │ Run ESLint-style checks and report issues. Admin only.       │   ║
║ └───────────────────────────────────────────────────────────────┘   ║
║ ┌───────────────────────────────────────────────────────────────┐   ║
║ │ admin.code.analyze                                            │   ║
║ │ Analyze a specific file for issues and suggest fixes.        │   ║
║ └───────────────────────────────────────────────────────────────┘   ║
║ ┌───────────────────────────────────────────────────────────────┐   ║
║ │ admin.code.edit                                               │   ║
║ │ Propose edits to a specific file (shows diff, does not       │   ║
║ │ auto-save). Admin only.                                       │   ║
║ └───────────────────────────────────────────────────────────────┘   ║
║                                                                       ║
║ 📊 Crawler Management                                                ║
║ ┌───────────────────────────────────────────────────────────────┐   ║
║ │ admin.crawler.list                                            │   ║
║ │ List all crawler jobs with their status. Admin only.         │   ║
║ └───────────────────────────────────────────────────────────────┘   ║
║ ┌───────────────────────────────────────────────────────────────┐   ║
║ │ admin.crawler.run                                             │   ║
║ │ Trigger any crawler type with custom parameters.             │   ║
║ └───────────────────────────────────────────────────────────────┘   ║
║ ┌───────────────────────────────────────────────────────────────┐   ║
║ │ admin.crawler.check                                           │   ║
║ │ Validate crawler outputs and check for errors.               │   ║
║ └───────────────────────────────────────────────────────────────┘   ║
║ ┌───────────────────────────────────────────────────────────────┐   ║
║ │ admin.crawler.retry                                           │   ║
║ │ Retry a failed crawler job. Admin only.                      │   ║
║ └───────────────────────────────────────────────────────────────┘   ║
║ ┌───────────────────────────────────────────────────────────────┐   ║
║ │ admin.crawler.cancel                                          │   ║
║ │ Cancel a running crawler job. Admin only.                    │   ║
║ └───────────────────────────────────────────────────────────────┘   ║
║                                                                       ║
║ 🗄️ Database & Diagnostics                                           ║
║ ┌───────────────────────────────────────────────────────────────┐   ║
║ │ admin.db.query                                                │   ║
║ │ Run read-only SQL queries for diagnostics (SELECT only).     │   ║
║ └───────────────────────────────────────────────────────────────┘   ║
║ ┌───────────────────────────────────────────────────────────────┐   ║
║ │ admin.db.stats                                                │   ║
║ │ Get database health statistics. Admin only.                  │   ║
║ └───────────────────────────────────────────────────────────────┘   ║
║                                                                       ║
║ 🏥 Health & Monitoring                                               ║
║ ┌───────────────────────────────────────────────────────────────┐   ║
║ │ admin.health.check                                            │   ║
║ │ Full system health report. Admin only.                       │   ║
║ └───────────────────────────────────────────────────────────────┘   ║
║ ┌───────────────────────────────────────────────────────────────┐   ║
║ │ admin.health.logs                                             │   ║
║ │ Get recent error/warning logs. Admin only.                   │   ║
║ └───────────────────────────────────────────────────────────────┘   ║
║                                                                       ║
║ 🔧 Function Testing                                                  ║
║ ┌───────────────────────────────────────────────────────────────┐   ║
║ │ admin.functions.test                                          │   ║
║ │ Execute a backend endpoint/function and capture results.     │   ║
║ └───────────────────────────────────────────────────────────────┘   ║
║ ┌───────────────────────────────────────────────────────────────┐   ║
║ │ admin.functions.diagnose                                      │   ║
║ │ Run a function with detailed error tracing.                  │   ║
║ └───────────────────────────────────────────────────────────────┘   ║
║                                                                       ║
╠═══════════════════════════════════════════════════════════════════════╣
║ ℹ️ Ask Anya to use any of these tools by referencing their name     ║
║ in your message.                                          [Close]    ║
╚═══════════════════════════════════════════════════════════════════════╝
```

## Screenshot 4: Admin in Action - Health Check
```
┌─────────────────────────────────────────────────────────────────────┐
│ Anya, your GrantFlow copilot  [🛡️ ADMIN]                           │
├─────────────────────────────────────────────────────────────────────┤
│ 💬 You                                              5 seconds ago   │
│ ┌─────────────────────────────────────────────────────────────────┐ │
│ │ Can you run a system health check?                             │ │
│ └─────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│ 🤖 Anya                                             2 seconds ago   │
│ ┌─────────────────────────────────────────────────────────────────┐ │
│ │ I've run a system health check. Here's what I found:           │ │
│ │                                                                 │ │
│ │ ✅ Database: Up (SQLite)                                        │ │
│ │ ✅ Crawlers: Up (0 running jobs)                                │ │
│ │ ✅ Environment: Healthy                                         │ │
│ │    - Node version: v20.18.0                                     │ │
│ │    - Uptime: 3,600 seconds                                      │ │
│ │    - Memory: 256 MB                                             │ │
│ │                                                                 │ │
│ │ Overall status: Healthy ✅                                      │ │
│ │                                                                 │ │
│ │ Tool: admin.health.check                                        │ │
│ │ ┌─────────────────────────────────────────────────────────────┐ │ │
│ │ │ {                                                           │ │ │
│ │ │   "status": "healthy",                                      │ │ │
│ │ │   "timestamp": "2026-01-03T05:11:36.277Z",                  │ │ │
│ │ │   "services": {                                             │ │ │
│ │ │     "database": { "status": "up", "type": "SQLite" },      │ │ │
│ │ │     "crawlers": { "status": "up", "running_jobs": 0 },     │ │ │
│ │ │     "environment": {                                        │ │ │
│ │ │       "node_version": "v20.18.0",                           │ │ │
│ │ │       "uptime_seconds": 3600,                               │ │ │
│ │ │       "memory_usage_mb": 256                                │ │ │
│ │ │     }                                                        │ │ │
│ │ │   }                                                          │ │ │
│ │ │ }                                                           │ │ │
│ │ └─────────────────────────────────────────────────────────────┘ │ │
│ └─────────────────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────────┤
│ [Ask Anya for help...]                                      [Send] │
└─────────────────────────────────────────────────────────────────────┘

Audit log:
[anyaToolRegistry] Admin tool invoked: {
  tool: 'admin.health.check',
  user: 'admin-user-123',
  timestamp: '2026-01-03T05:11:36.277Z'
}
```

## Screenshot 5: Access Denied for Regular User
```
┌─────────────────────────────────────────────────────────────────────┐
│ Anya, your GrantFlow copilot                                        │
├─────────────────────────────────────────────────────────────────────┤
│ 💬 You                                              5 seconds ago   │
│ ┌─────────────────────────────────────────────────────────────────┐ │
│ │ Can you run admin.health.check?                                 │ │
│ └─────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│ 🤖 Anya                                             2 seconds ago   │
│ ┌─────────────────────────────────────────────────────────────────┐ │
│ │ ⚠️ Error: Tool "admin.health.check" requires admin privileges.  │ │
│ │                                                                 │ │
│ │ This tool is restricted to administrators only. If you need    │ │
│ │ access to admin features, please contact your system           │ │
│ │ administrator.                                                  │ │
│ └─────────────────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────────┤
│ [Ask Anya for help...]                                      [Send] │
└─────────────────────────────────────────────────────────────────────┘

HTTP 403 Forbidden
```

## Key Visual Elements

### Color Scheme
- **Admin Badge**: Purple background (`#9333ea`)
- **Admin Tools Button**: Purple border and hover (`border-purple-300`, `bg-purple-50`)
- **Tool Names**: Purple text (`text-purple-600`)
- **Regular Content**: Blue/slate tones

### Icons Used (Lucide React)
- 🛡️ `Shield` - Admin badge
- 🔧 `Wrench` - Admin tools button and function testing
- 💻 `Code` - Code analysis category
- 📊 `Activity` - Crawler management and health monitoring
- 🗄️ `Database` - Database tools
- 🔍 `Search` - Code search
- ✨ `Sparkles` - Grant insights
- ➕ `Plus` - Add task

### Responsive Design
- Mobile: Stacked layout, full-width buttons
- Desktop: Horizontal layout, multi-column tool grid
- Dialog: Max width 3xl, scrollable content

## Accessibility Features
- Semantic HTML elements
- ARIA labels on all interactive elements
- Keyboard navigation support
- Screen reader friendly descriptions
- High contrast color ratios

## Browser Compatibility
- Chrome/Edge: Full support
- Firefox: Full support
- Safari: Full support
- Mobile browsers: Responsive layout
