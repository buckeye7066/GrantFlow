/**
 * Mission-aware audit service.
 *
 * Replaces the noisy generic code crawl with a focused pass over the
 * codebase that prioritises the things GrantFlow actually cares about:
 *   - Trustworthy opportunities (real URLs, link integrity, trusted sources)
 *   - Profile isolation / eligibility scoping
 *   - SQL identifier safety
 *   - Placeholder / simulated implementations leaking into production paths
 *   - Tool-registry drift (duplicate registrations, overlapping names)
 *
 * Intentionally narrow: we'd rather miss a smell than drown admins in
 * optional-chaining / await-without-try nonsense.
 */

import { promises as fs } from 'fs'
import path from 'path'

const REPO_ROOT = path.resolve(process.cwd())
const CODE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'])

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.turbo',
  '.cursor',
  '.idea',
  '.vscode',
  'uploads',
  'data',
])

async function walk(dir, out = []) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue
    if (entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await walk(full, out)
    } else if (entry.isFile() && CODE_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(full)
    }
  }
  return out
}

function pushFinding(findings, file, line, severity, description, preview, fix, category) {
  findings.push({
    file,
    line,
    severity,
    category,
    description,
    preview: String(preview || '').trim().slice(0, 180),
    fix,
  })
}

/**
 * Run the mission-aware audit across the repo.
 *
 * @returns {Promise<{
 *   scannedFiles: number,
 *   findingsCount: number,
 *   byCategory: Record<string, number>,
 *   bySeverity: Record<string, number>,
 *   rootProblems: Array<object>,
 *   findings: Array<object>,
 * }>}
 */
export async function runMissionAudit() {
  const files = await walk(REPO_ROOT)
  const findings = []
  const toolRegistrationCounts = new Map()

  for (const abs of files) {
    const rel = path.relative(REPO_ROOT, abs)
    let content
    try {
      content = await fs.readFile(abs, 'utf8')
    } catch {
      continue
    }
    const lines = content.split('\n')

    lines.forEach((rawLine, idx) => {
      const n = idx + 1
      const trimmed = String(rawLine || '').trim()
      if (!trimmed) return

      // Placeholder / simulated logic leaking into production paths.
      if (
        /status:\s*['"]simulated['"]/i.test(trimmed) ||
        /note:\s*['"][^'"]*would require/i.test(trimmed)
      ) {
        pushFinding(
          findings,
          rel,
          n,
          'critical',
          'Simulated or placeholder implementation in production path',
          trimmed,
          'Replace with real implementation or clearly isolate from production tool registry',
          'placeholder_logic',
        )
      }

      // Opportunity queries missing trust/eligibility context.
      if (
        /FROM\s+funding_opportunities/i.test(trimmed) &&
        !/trustedOriginClause|trustedSourceClause|profile_id|\bis_national\b|\bstate\b/i.test(trimmed)
      ) {
        pushFinding(
          findings,
          rel,
          n,
          'warning',
          'Opportunity query may lack trust/source/profile scope protections',
          trimmed,
          'Review for trusted origin/source filtering, profile scope, and safe fallback rules',
          'matching_integrity',
        )
      }

      // Opportunity writes missing URL / link integrity metadata.
      if (
        /INSERT\s+INTO\s+funding_opportunities/i.test(trimmed) &&
        !/application_url|source_url|link_status/i.test(trimmed)
      ) {
        pushFinding(
          findings,
          rel,
          n,
          'warning',
          'Opportunity persistence may omit URL/link integrity fields',
          trimmed,
          'Ensure persisted opportunities include application_url, source_url, and link_status metadata',
          'opportunity_trust',
        )
      }

      // Dynamic SQL -- identifier allowlisting review required.
      if (/db\.(prepare|get|all|run)\s*\(\s*`/.test(trimmed) && trimmed.includes('${')) {
        const hasGuard =
          /allowedTable|ALLOWED_TABLE|SAFE_TABLE|assertAllowed|validateIdentifier|assertSafeIdentifier|safeSqlIdentifier|APPLY_ENGINE_TABLES/.test(
            trimmed,
          )
        pushFinding(
          findings,
          rel,
          n,
          hasGuard ? 'info' : 'warning',
          hasGuard
            ? 'Dynamic SQL present (identifier guard detected)'
            : 'Dynamic SQL requires identifier allowlisting review',
          trimmed,
          'Ensure interpolated identifiers are hard-allowlisted (e.g. via backend/utils/safeSql.js) and values remain parameterized',
          'sql_safety',
        )
      }

      // Tool registration drift -- count registrations per tool name so we can
      // report duplicates that silently override each other.
      const regMatch = trimmed.match(/name:\s*['"]([a-z0-9_.\-]+)['"]/i)
      if (regMatch) {
        // Only count lines that look like they're inside a registerTool call.
        // Cheap heuristic: same line contains registerTool OR previous
        // non-blank line contains registerTool.
        const likelyRegistration =
          /registerTool\s*\(/.test(trimmed) ||
          (idx > 0 && /registerTool\s*\(/.test(lines[idx - 1]))
        if (likelyRegistration) {
          const key = regMatch[1]
          const list = toolRegistrationCounts.get(key) || []
          list.push({ file: rel, line: n })
          toolRegistrationCounts.set(key, list)
        }
      }
    })
  }

  // Emit tool-registration drift findings.
  for (const [name, sites] of toolRegistrationCounts.entries()) {
    if (sites.length > 1) {
      sites.forEach((site) => {
        pushFinding(
          findings,
          site.file,
          site.line,
          'warning',
          `Duplicate tool registration for "${name}" (${sites.length} sites)`,
          `name: '${name}'`,
          'Consolidate duplicate registrations into one canonical implementation so later registrations do not silently override earlier ones',
          'tool_drift',
        )
      })
    }
  }

  // Aggregates
  const byCategory = {}
  const bySeverity = {}
  for (const f of findings) {
    byCategory[f.category] = (byCategory[f.category] || 0) + 1
    bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1
  }

  const rootProblems = [
    {
      problem: 'Audit noise from regex-based code inspection rather than syntax/mission-aware analysis',
      systems: ['Anya audit', 'admin tools'],
      likely_files: ['backend/services/anyaAdminTools.js', 'backend/services/anyaToolRegistry.js'],
    },
    {
      problem: 'Dynamic SQL review lacks identifier-trust distinction',
      systems: ['Apply engine', 'DB safety'],
      likely_files: ['backend/apply/applyEngine.js', 'backend/utils/safeSql.js'],
    },
    {
      problem: 'Placeholder or simulated tooling remaining in admin paths',
      systems: ['Diagnostics', 'function testing'],
      likely_files: ['backend/services/anyaAdminTools.js'],
    },
    {
      problem: 'Duplicate/overlapping tool registrations cause silent behaviour overrides',
      systems: ['Tool registry'],
      likely_files: ['backend/services/anyaToolRegistry.js'],
    },
  ]

  return {
    scannedFiles: files.length,
    findingsCount: findings.length,
    byCategory,
    bySeverity,
    rootProblems,
    findings: findings.slice(0, 500),
    generated_at: new Date().toISOString(),
  }
}
