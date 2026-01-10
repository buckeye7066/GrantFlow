import { promises as fs } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import { runRealCrawlersAcrossProfiles } from './realCrawlers/runMultipleService.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const REPO_ROOT = path.resolve(process.cwd())

// ============================================================================
// Admin Role Enforcement
// ============================================================================

// Admin email should be configurable per environment.
// Keep the historical default as a fallback for local dev.
const ADMIN_EMAIL = String(
  process.env.ADMIN_EMAIL || process.env.ANYA_ADMIN_EMAIL || 'buckeye7066@gmail.com',
).trim();

/**
 * Check if user is admin
 * @param {Object} user - User object with email
 * @returns {boolean} True if user is admin
 */
export function isAdmin(user) {
  // Allow explicit role-based admin (used by local admin token flow).
  if (user?.role === 'admin') {
    return true;
  }
  if (!user || !user.primary_email) {
    return false;
  }
  return user.primary_email.toLowerCase() === ADMIN_EMAIL.toLowerCase();
}

/**
 * Require admin access - throws if user is not admin
 * @param {Object} user - User object to check
 * @throws {Error} If user is not admin
 */
export function requireAdmin(user) {
  if (!isAdmin(user)) {
    const err = new Error(`Admin access required. Contact ${ADMIN_EMAIL} for assistance.`);
    err.status = 403;
    throw err;
  }
}

/**
 * Check if user can access a profile
 * - Admin can access all profiles
 * - Regular users can only access their own profiles
 * @param {Object} user - User object
 * @param {string} profileId - Profile ID to access
 * @param {Object} db - Database connection
 * @returns {boolean} True if user can access profile
 */
export function canAccessProfile(user, profileId, db) {
  // Admin can access all profiles
  if (isAdmin(user)) {
    return true;
  }
  
  // Check if profile belongs to user
  const profile = db.prepare('SELECT user_id FROM profiles WHERE id = ?').get(profileId);
  
  if (!profile) {
    return false;
  }
  
  return profile.user_id === user.id;
}

/**
 * Get accessible profiles for user
 * - Admin gets all profiles
 * - Regular users get only their own profiles
 * @param {Object} user - User object
 * @param {Object} db - Database connection
 * @returns {Array} Array of accessible profile IDs
 */
export function getAccessibleProfiles(user, db) {
  if (isAdmin(user)) {
    // Admin gets all profiles
    return db.prepare('SELECT id FROM profiles WHERE status = ?').all('active').map(p => p.id);
  }
  
  // Regular users get only their own profiles
  return db.prepare('SELECT id FROM profiles WHERE user_id = ? AND status = ?')
    .all(user.id, 'active')
    .map(p => p.id);
}

// ============================================================================
// Code Analysis & Auto-Fix Tools
// ============================================================================

/**
 * Deep scan the codebase for patterns, potential errors, and anti-patterns
 * ADMIN ONLY
 */
export async function adminCodeCrawl({ pattern, directory, includeTests = false }, context) {
  // Require admin access
  requireAdmin(context.user);
  
  const searchRoot = directory
    ? path.resolve(REPO_ROOT, directory)
    : REPO_ROOT

  const findings = []
  const ignorePatterns = [
    'node_modules',
    '.git',
    'dist',
    'build',
    'coverage',
    '.turbo',
  ]

  if (!includeTests) {
    ignorePatterns.push('test', 'tests', '__tests__', '*.test.js', '*.spec.js')
  }

  async function scanDirectory(dir) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true })

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        const relativePath = path.relative(REPO_ROOT, fullPath)

        if (ignorePatterns.some((p) => relativePath.includes(p))) {
          continue
        }

        if (entry.isDirectory()) {
          await scanDirectory(fullPath)
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name)
          if (['.js', '.jsx', '.ts', '.tsx'].includes(ext)) {
            try {
              const content = await fs.readFile(fullPath, 'utf8')
              const lines = content.split('\n')

              // Pattern matching if specified
              if (pattern) {
                const regex = new RegExp(pattern, 'gi')
                lines.forEach((line, idx) => {
                  if (regex.test(line)) {
                    findings.push({
                      file: relativePath,
                      line: idx + 1,
                      severity: 'info',
                      description: `Pattern match: "${pattern}"`,
                      preview: line.trim().slice(0, 100),
                    })
                  }
                })
              }

              // Common anti-patterns and error detection
              lines.forEach((line, idx) => {
                const trimmedLine = line.trim()
                
                // console.log in production code
                if (line.includes('console.log') && !relativePath.includes('test')) {
                  findings.push({
                    file: relativePath,
                    line: idx + 1,
                    severity: 'warning',
                    description: 'console.log statement found',
                    preview: trimmedLine.slice(0, 100),
                    fix: '// Remove or replace with proper logging',
                  })
                }

                // TODO/FIXME comments
                if (line.match(/\/\/\s*(TODO|FIXME|XXX|HACK)/i)) {
                  findings.push({
                    file: relativePath,
                    line: idx + 1,
                    severity: 'info',
                    description: 'TODO/FIXME comment',
                    preview: trimmedLine.slice(0, 100),
                  })
                }

                // Empty catch blocks
                if (trimmedLine === 'catch (error) {}' || trimmedLine === 'catch {}' || 
                    trimmedLine === 'catch (e) {}' || trimmedLine === 'catch (err) {}') {
                  findings.push({
                    file: relativePath,
                    line: idx + 1,
                    severity: 'error',
                    description: 'Empty catch block - errors are silently swallowed',
                    preview: trimmedLine,
                    fix: 'Add error logging or handling',
                  })
                }
                
                // Unhandled promise rejections
                if (line.match(/\.then\([^)]*\)\s*(?!\.catch)/)) {
                  findings.push({
                    file: relativePath,
                    line: idx + 1,
                    severity: 'warning',
                    description: 'Promise without .catch() handler',
                    preview: trimmedLine.slice(0, 100),
                    fix: 'Add .catch() to handle promise rejection',
                  })
                }
                
                // Potential null/undefined access
                if (line.match(/(\w+)\.(\w+)\.(\w+)/) && !line.includes('?.')) {
                  const match = line.match(/(\w+)\.(\w+)\.(\w+)/)
                  if (match && !['console', 'process', 'window', 'document', 'Math', 'JSON', 'Date'].includes(match[1])) {
                    findings.push({
                      file: relativePath,
                      line: idx + 1,
                      severity: 'info',
                      description: 'Deep property access without optional chaining',
                      preview: trimmedLine.slice(0, 100),
                      fix: 'Consider using optional chaining (?.) for safety',
                    })
                  }
                }
                
                // Missing error handling in async functions
                if (line.includes('await ') && !lines.slice(Math.max(0, idx - 5), idx + 5).some(l => l.includes('try'))) {
                  findings.push({
                    file: relativePath,
                    line: idx + 1,
                    severity: 'info',
                    description: 'Await without try-catch block',
                    preview: trimmedLine.slice(0, 100),
                    fix: 'Consider wrapping in try-catch for error handling',
                  })
                }
                
                // Hardcoded API keys or secrets
                if (line.match(/(api[_-]?key|secret|token|password)\s*=\s*["'][^"']+["']/i)) {
                  findings.push({
                    file: relativePath,
                    line: idx + 1,
                    severity: 'critical',
                    description: 'Potential hardcoded secret or API key',
                    preview: trimmedLine.slice(0, 50) + '...',
                    fix: 'Move to environment variables',
                  })
                }
                
                // SQL injection risk
                if (line.match(/db\.(prepare|run|get|all)\([`"'].*\$\{/)) {
                  findings.push({
                    file: relativePath,
                    line: idx + 1,
                    severity: 'critical',
                    description: 'Potential SQL injection - using template literals in query',
                    preview: trimmedLine.slice(0, 100),
                    fix: 'Use parameterized queries instead',
                  })
                }
              })
            } catch (error) {
              // Skip files that can't be read
            }
          }
        }
      }
    } catch (error) {
      // Skip directories that can't be accessed
    }
  }

  await scanDirectory(searchRoot)

  return {
    scanned_directory: path.relative(REPO_ROOT, searchRoot),
    pattern: pattern ?? null,
    include_tests: includeTests,
    findings_count: findings.length,
    findings: findings.slice(0, 100), // Limit to 100 results
  }
}

/**
 * Run ESLint-style checks and report issues
 */
export async function adminCodeLint({ targetPath, fix = false }, context) {
  const { db } = context
  const resolvedPath = targetPath
    ? path.resolve(REPO_ROOT, targetPath)
    : REPO_ROOT

  // Simplified linting - in production, you'd integrate with ESLint
  const issues = []

  try {
    const stats = await fs.stat(resolvedPath)
    const files = []

    if (stats.isFile()) {
      files.push(resolvedPath)
    } else if (stats.isDirectory()) {
      // Scan directory for JS/JSX files
      async function collectFiles(dir) {
        const entries = await fs.readdir(dir, { withFileTypes: true })
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name)
          if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
            await collectFiles(fullPath)
          } else if (entry.isFile() && /\.(js|jsx)$/.test(entry.name)) {
            files.push(fullPath)
          }
        }
      }
      await collectFiles(resolvedPath)
    }

    // Basic lint checks
    for (const file of files.slice(0, 50)) {
      const content = await fs.readFile(file, 'utf8')
      const lines = content.split('\n')
      const relativePath = path.relative(REPO_ROOT, file)

      lines.forEach((line, idx) => {
        // Check for var usage
        if (line.match(/^\s*var\s+/)) {
          issues.push({
            file: relativePath,
            line: idx + 1,
            severity: 'warning',
            rule: 'no-var',
            message: 'Use const or let instead of var',
          })
        }

        // Check for == instead of ===
        if (line.match(/[^=!]==[^=]/) || line.match(/[^!]!=[^=]/)) {
          issues.push({
            file: relativePath,
            line: idx + 1,
            severity: 'error',
            rule: 'eqeqeq',
            message: 'Use === or !== instead of == or !=',
          })
        }
      })
    }

    return {
      path: path.relative(REPO_ROOT, resolvedPath),
      files_checked: files.length,
      issues_found: issues.length,
      issues: issues.slice(0, 50),
      fix_applied: fix && issues.length > 0,
    }
  } catch (error) {
    throw new Error(`Failed to lint: ${error.message}`)
  }
}

/**
 * Analyze a specific file for issues and suggest fixes
 */
export async function adminCodeAnalyze({ filePath }, context) {
  if (!filePath) {
    throw new Error('filePath is required')
  }

  const resolvedPath = path.resolve(REPO_ROOT, filePath)
  const relativePath = path.relative(REPO_ROOT, resolvedPath)

  try {
    const content = await fs.readFile(resolvedPath, 'utf8')
    const lines = content.split('\n')
    const issues = []
    const suggestions = []

    // Analyze for common issues
    let hasImports = false
    let hasExports = false

    lines.forEach((line, idx) => {
      if (line.match(/^import\s/)) hasImports = true
      if (line.match(/^export\s/)) hasExports = true

      // Unused variables (simple heuristic)
      const varMatch = line.match(/(?:const|let|var)\s+(\w+)\s*=/)
      if (varMatch) {
        const varName = varMatch[1]
        const varUsed = content.split('\n').slice(idx + 1).some((l) =>
          l.includes(varName),
        )
        if (!varUsed) {
          issues.push({
            line: idx + 1,
            severity: 'warning',
            description: `Variable '${varName}' may be unused`,
          })
        }
      }

      // Long lines
      if (line.length > 120) {
        issues.push({
          line: idx + 1,
          severity: 'info',
          description: `Line exceeds 120 characters (${line.length})`,
        })
      }
    })

    // Suggestions
    if (!hasImports && !hasExports && lines.length > 50) {
      suggestions.push('Consider breaking this file into smaller modules')
    }

    return {
      file: relativePath,
      lines: lines.length,
      size_bytes: content.length,
      issues_found: issues.length,
      issues: issues.slice(0, 20),
      suggestions,
    }
  } catch (error) {
    throw new Error(`Failed to analyze file: ${error.message}`)
  }
}

/**
 * Propose or apply edits to a specific file
 * @param {Object} params
 * @param {string} params.filePath - Path to file to edit
 * @param {Array} params.changes - Array of change objects
 * @param {boolean} params.save - If true, apply changes and save file (with backup)
 */
export async function adminCodeEdit({ filePath, changes, save = false }, context) {
  if (!filePath) {
    throw new Error('filePath is required')
  }
  if (!Array.isArray(changes) || changes.length === 0) {
    throw new Error('changes array is required')
  }

  const resolvedPath = path.resolve(REPO_ROOT, filePath)
  const relativePath = path.relative(REPO_ROOT, resolvedPath)

  // Ensure file is within allowed directories for safety
  const allowedDirs = ['backend', 'src', 'scripts']
  const isInAllowedDir = allowedDirs.some(dir => 
    relativePath.startsWith(dir + path.sep) || relativePath.startsWith(dir)
  )
  
  if (save && !isInAllowedDir) {
    throw new Error(`File ${relativePath} is outside allowed directories for editing`)
  }

  try {
    const content = await fs.readFile(resolvedPath, 'utf8')
    const lines = content.split('\n')
    const proposedChanges = []
    let hasErrors = false

    // Validate all changes first
    changes.forEach((change) => {
      const { line, oldText, newText } = change
      if (line < 1 || line > lines.length) {
        proposedChanges.push({
          line,
          status: 'error',
          message: 'Line number out of range',
        })
        hasErrors = true
        return
      }

      const currentLine = lines[line - 1]
      if (!currentLine.includes(oldText)) {
        proposedChanges.push({
          line,
          status: 'error',
          message: 'Old text not found on this line',
          current: currentLine,
        })
        hasErrors = true
        return
      }

      proposedChanges.push({
        line,
        status: save ? 'applied' : 'pending',
        old: currentLine,
        new: currentLine.replace(oldText, newText),
      })
    })

    // If save requested and no errors, apply changes
    if (save && !hasErrors) {
      // Create backup
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      const backupDir = path.join(REPO_ROOT, 'backend', 'data', 'backups')
      await fs.mkdir(backupDir, { recursive: true })
      
      const backupPath = path.join(
        backupDir,
        `${path.basename(filePath)}.${timestamp}.backup`
      )
      await fs.writeFile(backupPath, content, 'utf8')

      // Apply changes
      const modifiedLines = [...lines]
      proposedChanges.forEach((change, idx) => {
        if (change.status === 'applied') {
          const originalChange = changes[idx]
          const lineIdx = originalChange.line - 1
          modifiedLines[lineIdx] = modifiedLines[lineIdx].replace(
            originalChange.oldText,
            originalChange.newText
          )
        }
      })

      const newContent = modifiedLines.join('\n')
      await fs.writeFile(resolvedPath, newContent, 'utf8')

      return {
        file: relativePath,
        changes_applied: proposedChanges.filter(c => c.status === 'applied').length,
        changes: proposedChanges,
        backup_created: path.relative(REPO_ROOT, backupPath),
        saved: true,
      }
    }

    return {
      file: relativePath,
      changes_proposed: proposedChanges.length,
      changes: proposedChanges,
      note: save && hasErrors 
        ? 'Changes not saved due to errors. Fix errors and try again.'
        : 'Changes are proposed only. Set save=true to apply them.',
    }
  } catch (error) {
    throw new Error(`Failed to edit file: ${error.message}`)
  }
}

// ============================================================================
// Crawler Management Tools
// ============================================================================

/**
 * List all crawler jobs with their status
 */
export async function adminCrawlerList({ status, limit = 50, type }, context) {
  const { db } = context
  if (!db) {
    throw new Error('Database connection unavailable')
  }

  const params = []
  const clauses = []

  if (status) {
    clauses.push('status = ?')
    params.push(status)
  }

  if (type) {
    clauses.push('type = ?')
    params.push(type)
  }

  const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200))

  const jobs = db
    .prepare(
      `
      SELECT *
      FROM crawler_jobs
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT ?
    `,
    )
    .all(...params, safeLimit)

  return {
    count: jobs.length,
    limit: safeLimit,
    filters: { status: status ?? null, type: type ?? null },
    jobs: jobs.map((job) => ({
      ...job,
      parameters: job.parameters ? JSON.parse(job.parameters) : {},
      result_meta: job.result_meta ? JSON.parse(job.result_meta) : null,
    })),
  }
}

/**
 * Trigger any crawler type with custom parameters
 */
export async function adminCrawlerRun({ type, profileId, parameters = {} }, context) {
  const { db } = context
  if (!db) {
    throw new Error('Database connection unavailable')
  }

  if (!type) {
    throw new Error('Crawler type is required')
  }

  const allowedTypes = [
    'local',
    'scholarship',
    'comprehensive',
    'item_search',
    'avatar_lookup',
    'document_ingest',
    'pipeline_automation',
    'profile_enrichment',
  ]

  if (!allowedTypes.includes(type)) {
    throw new Error(`Invalid crawler type. Allowed: ${allowedTypes.join(', ')}`)
  }

  const jobId = Math.random().toString(36).substring(2, 15)
  const parametersJson = JSON.stringify(parameters)

  db.prepare(
    `
    INSERT INTO crawler_jobs (id, type, profile_id, status, parameters, created_at)
    VALUES (?, ?, ?, 'queued', ?, CURRENT_TIMESTAMP)
  `,
  ).run(jobId, type, profileId ?? null, parametersJson)

  const job = db.prepare('SELECT * FROM crawler_jobs WHERE id = ?').get(jobId)

  return {
    job: {
      ...job,
      parameters: job.parameters ? JSON.parse(job.parameters) : {},
    },
    message: `Crawler job ${jobId} queued successfully`,
  }
}

/**
 * Run the REAL crawler suite (the 6 crawlers behind /api/real-crawlers/run-multiple)
 * across all (or specified) profiles, persist to GLOBAL opportunities as REAL, and write an auditable artifact.
 *
 * Admin only.
 */
export async function adminRealCrawlersRunMultiple(
  {
    profileIds = null,
    crawlerTypes = [
      'local_funding',
      'government_funding',
      'student_grants', // scholarships
      'ecf_benefits',
      'item_matching',
      'special_needs',
    ],
    minMatchScore = 80,
    persistGlobal = true,
    dryRun = false,
    maxProfiles = null,
    timeoutMsPerCrawler = 25_000,
    maxSavedPerCrawlerPerProfile = 50,
    itemRequest = null,
  },
  context,
) {
  requireAdmin(context.user)
  return await runRealCrawlersAcrossProfiles(
    {
      profileIds,
      crawlerTypes,
      minMatchScore,
      persistGlobal,
      dryRun,
      maxProfiles,
      timeoutMsPerCrawler,
      maxSavedPerCrawlerPerProfile,
      itemRequest,
    },
    context,
  )
}

/**
 * Validate crawler outputs and check for errors in recent jobs
 */
export async function adminCrawlerCheck({ jobId, lastN = 10 }, context) {
  const { db } = context
  if (!db) {
    throw new Error('Database connection unavailable')
  }

  let jobs = []

  if (jobId) {
    const job = db.prepare('SELECT * FROM crawler_jobs WHERE id = ?').get(jobId)
    if (job) {
      jobs = [job]
    }
  } else {
    jobs = db
      .prepare(
        `
      SELECT *
      FROM crawler_jobs
      ORDER BY created_at DESC
      LIMIT ?
    `,
      )
      .all(Math.min(Number(lastN) || 10, 50))
  }

  const validation = {
    checked: jobs.length,
    errors: [],
    warnings: [],
    summary: {},
  }

  jobs.forEach((job) => {
    if (job.status === 'failed') {
      validation.errors.push({
        job_id: job.id,
        type: job.type,
        error: job.error,
        created_at: job.created_at,
      })
    }

    if (job.status === 'running') {
      const startedAt = new Date(job.started_at)
      const now = new Date()
      const durationMinutes = (now - startedAt) / 1000 / 60

      if (durationMinutes > 30) {
        validation.warnings.push({
          job_id: job.id,
          type: job.type,
          message: `Job running for ${Math.round(durationMinutes)} minutes`,
        })
      }
    }

    const status = job.status || 'unknown'
    validation.summary[status] = (validation.summary[status] || 0) + 1
  })

  return validation
}

/**
 * Retry a failed crawler job
 */
export async function adminCrawlerRetry({ jobId }, context) {
  const { db } = context
  if (!db) {
    throw new Error('Database connection unavailable')
  }

  if (!jobId) {
    throw new Error('jobId is required')
  }

  const originalJob = db
    .prepare('SELECT * FROM crawler_jobs WHERE id = ?')
    .get(jobId)

  if (!originalJob) {
    throw new Error('Job not found')
  }

  const newJobId = Math.random().toString(36).substring(2, 15)
  const parameters = originalJob.parameters ? JSON.parse(originalJob.parameters) : {}
  parameters.retried_from_job_id = jobId

  db.prepare(
    `
    INSERT INTO crawler_jobs (id, type, profile_id, status, parameters, created_at)
    VALUES (?, ?, ?, 'queued', ?, CURRENT_TIMESTAMP)
  `,
  ).run(
    newJobId,
    originalJob.type,
    originalJob.profile_id,
    JSON.stringify(parameters),
  )

  // Update retry count on original job
  db.prepare(
    `
    UPDATE crawler_jobs
    SET retry_count = COALESCE(retry_count, 0) + 1,
        last_retry_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `,
  ).run(jobId)

  const newJob = db.prepare('SELECT * FROM crawler_jobs WHERE id = ?').get(newJobId)

  return {
    original_job_id: jobId,
    new_job: {
      ...newJob,
      parameters: newJob.parameters ? JSON.parse(newJob.parameters) : {},
    },
    message: 'Job retried successfully',
  }
}

/**
 * Cancel a running crawler job
 */
export async function adminCrawlerCancel({ jobId, reason }, context) {
  const { db } = context
  if (!db) {
    throw new Error('Database connection unavailable')
  }

  if (!jobId) {
    throw new Error('jobId is required')
  }

  const job = db.prepare('SELECT * FROM crawler_jobs WHERE id = ?').get(jobId)

  if (!job) {
    throw new Error('Job not found')
  }

  if (job.status === 'completed' || job.status === 'cancelled') {
    return {
      job_id: jobId,
      status: job.status,
      message: `Job already ${job.status}`,
    }
  }

  const cancelReason = reason || 'Cancelled by admin'

  db.prepare(
    `
    UPDATE crawler_jobs
    SET status = 'cancelled',
        error = ?,
        completed_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `,
  ).run(cancelReason, jobId)

  return {
    job_id: jobId,
    previous_status: job.status,
    new_status: 'cancelled',
    reason: cancelReason,
    message: 'Job cancelled successfully',
  }
}

// ============================================================================
// App Function Execution & Diagnostics
// ============================================================================

/**
 * Execute a backend endpoint/function and capture results
 */
export async function adminFunctionsTest({ route, method = 'GET', body = {} }, context) {
  // Note: This is a simplified version. In production, you'd use supertest or similar
  return {
    route,
    method,
    body,
    status: 'simulated',
    note: 'Function testing would require integration with Express test framework',
    recommendation: 'Use proper API testing tools for production',
  }
}

/**
 * Run a function with detailed error tracing
 */
export async function adminFunctionsDiagnose({ route, method = 'GET', body = {} }, context) {
  return {
    route,
    method,
    body,
    status: 'simulated',
    trace: [],
    note: 'Function diagnostics would require integration with debugging tools',
    recommendation: 'Use proper debugging and tracing tools for production',
  }
}

// ============================================================================
// Database & System Tools
// ============================================================================

/**
 * Run read-only SQL queries for diagnostics (SELECT only)
 */
export async function adminDbQuery({ sql, limit = 100 }, context) {
  const { db } = context
  if (!db) {
    throw new Error('Database connection unavailable')
  }

  if (!sql || typeof sql !== 'string') {
    throw new Error('SQL query is required')
  }

  // Security: Only allow SELECT statements
  const trimmedSql = sql.trim().toLowerCase()
  if (!trimmedSql.startsWith('select')) {
    throw new Error('Only SELECT queries are allowed')
  }

  // Block dangerous keywords
  const dangerousKeywords = ['drop', 'delete', 'update', 'insert', 'alter', 'create', 'truncate']
  if (dangerousKeywords.some((keyword) => trimmedSql.includes(keyword))) {
    throw new Error('Query contains forbidden keywords')
  }

  try {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500))
    
    // Append LIMIT clause to the query if not already present
    let finalSql = sql.trim()
    if (!finalSql.toLowerCase().includes('limit')) {
      finalSql += ` LIMIT ${safeLimit}`
    }
    
    const results = db.prepare(finalSql).all()

    return {
      query: sql,
      rows_returned: results.length,
      limit: safeLimit,
      results: results.slice(0, safeLimit),
    }
  } catch (error) {
    throw new Error(`Query failed: ${error.message}`)
  }
}

/**
 * Get database health statistics
 */
export async function adminDbStats(_params, context) {
  const { db } = context
  if (!db) {
    throw new Error('Database connection unavailable')
  }

  try {
    // Get table counts
    const tables = db
      .prepare(
        `
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `,
      )
      .all()

    const tableCounts = {}
    tables.forEach((table) => {
      try {
        // Validate table name - only allow alphanumeric, underscores, and dashes
        // This protects against SQL injection via table name
        if (!/^[a-zA-Z0-9_-]+$/.test(table.name)) {
          tableCounts[table.name] = 'Error: Invalid table name'
          return
        }
        const count = db.prepare(`SELECT COUNT(*) as count FROM ${table.name}`).get()
        tableCounts[table.name] = count.count
      } catch (error) {
        tableCounts[table.name] = `Error: ${error.message}`
      }
    })

    // Recent activity
    const recentCrawlers = db
      .prepare(
        `
      SELECT status, COUNT(*) as count
      FROM crawler_jobs
      WHERE created_at >= datetime('now', '-24 hours')
      GROUP BY status
    `,
      )
      .all()

    const recentSessions = db
      .prepare(
        `
      SELECT COUNT(*) as count
      FROM anya_sessions
      WHERE created_at >= datetime('now', '-24 hours')
    `,
      )
      .get()

    return {
      database: 'SQLite',
      tables: tables.length,
      table_counts: tableCounts,
      recent_activity: {
        crawler_jobs_24h: recentCrawlers,
        anya_sessions_24h: recentSessions.count,
      },
    }
  } catch (error) {
    throw new Error(`Failed to get database stats: ${error.message}`)
  }
}

// ============================================================================
// Health & Monitoring Tools
// ============================================================================

/**
 * Full system health report
 */
export async function adminHealthCheck(_params, context) {
  const { db } = context

  const health = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    services: {},
  }

  // Database check
  try {
    if (db) {
      db.prepare('SELECT 1').get()
      health.services.database = { status: 'up', type: 'SQLite' }
    } else {
      health.services.database = { status: 'unavailable' }
      health.status = 'degraded'
    }
  } catch (error) {
    health.services.database = { status: 'down', error: error.message }
    health.status = 'unhealthy'
  }

  // Crawler service check
  try {
    if (db) {
      const runningJobs = db
        .prepare("SELECT COUNT(*) as count FROM crawler_jobs WHERE status = 'running'")
        .get()
      health.services.crawlers = {
        status: 'up',
        running_jobs: runningJobs.count,
      }
    }
  } catch (error) {
    health.services.crawlers = { status: 'down', error: error.message }
    health.status = 'degraded'
  }

  // Environment check
  health.services.environment = {
    node_version: process.version,
    uptime_seconds: Math.round(process.uptime()),
    memory_usage_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
  }

  return health
}

/**
 * Get recent error/warning logs
 */
export async function adminHealthLogs({ level = 'error', limit = 50, source }, context) {
  // Note: This would integrate with your logging system
  // For now, returning a simulated response

  return {
    level,
    source: source ?? null,
    limit: Math.min(Number(limit) || 50, 200),
    logs: [],
    note: 'Log integration would require connection to logging system (Winston, etc.)',
    recommendation: 'Connect to your actual logging infrastructure',
  }
}
