import { execSync } from 'node:child_process'
import fs from 'node:fs'

function run(command, maxBufferMb = 50) {
  return execSync(command, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * maxBufferMb,
  })
}

function getAddedLines(patchText) {
  return (patchText.match(/^\+.*$/gm) || []).filter((line) => !line.startsWith('+++'))
}

function analyzeCommit({ sha, subject, date, files, patch }) {
  const findings = []

  if (/(^|\n)[+ ]?<{7}|(^|\n)[+ ]?={7}|(^|\n)[+ ]?>{7}/m.test(patch)) {
    findings.push('conflict_marker_pattern')
  }

  // Scope duplicate-declaration detection per-file to avoid false positives
  // from the same identifier being declared in two different files.
  const perFileLines = new Map() // filePath -> addedLines[]
  let currentFile = null
  for (const rawLine of patch.split(/\r?\n/)) {
    if (rawLine.startsWith('diff --git ')) {
      // Extract the b/ path as the current file context
      const m = rawLine.match(/diff --git a\/.+ b\/(.+)/)
      currentFile = m ? m[1] : rawLine
      if (!perFileLines.has(currentFile)) perFileLines.set(currentFile, [])
    } else if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
      if (currentFile) perFileLines.get(currentFile).push(rawLine)
    }
  }

  const allDuplicateDeclarations = []
  for (const [, fileLines] of perFileLines) {
    const declarationCounts = new Map()
    for (const line of fileLines) {
      const match = line.match(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\b/)
      if (!match) continue
      const name = match[1]
      declarationCounts.set(name, (declarationCounts.get(name) || 0) + 1)
    }
    const fileDuplicates = [...declarationCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(([name]) => name)
    allDuplicateDeclarations.push(...fileDuplicates)
  }
  const duplicateDeclarations = allDuplicateDeclarations.slice(0, 20)
  if (duplicateDeclarations.length > 0) {
    findings.push(`duplicate_added_declarations:${duplicateDeclarations.join(',')}`)
  }

  const addedLines = getAddedLines(patch)
  const repeatedLineCounts = new Map()
  for (const line of addedLines) {
    const normalized = line.slice(1).trim()
    if (normalized.length < 24) continue
    repeatedLineCounts.set(normalized, (repeatedLineCounts.get(normalized) || 0) + 1)
  }
  const repeatedLongLines = [...repeatedLineCounts.values()].filter((count) => count > 1).length
  if (repeatedLongLines > 6) {
    findings.push(`high_repeated_added_lines:${repeatedLongLines}`)
  }

  if (/\[CodeGuard\]/i.test(subject)) {
    findings.push('automation_commit_codeguard')
  }
  if (/made-with:\s*cursor/i.test(subject)) {
    findings.push('automation_commit_cursor')
  }

  return { sha, date, subject, files, findings }
}

function main() {
  const outPath = process.env.COMMIT_AUDIT_OUT_PATH
  || new URL('../../agent-tools/commit-audit-14d.json', import.meta.url).pathname
  const rawCommits = run('git log main --since=\"14 days ago\" --pretty=format:%H%x09%s%x09%ad --date=iso')
  const commitLines = rawCommits.split(/\r?\n/).filter(Boolean)
  const commits = []

  for (const line of commitLines) {
    const [sha, subject, date] = line.split('\t')
    let files = []
    let patch = ''
    try {
      files = run(`git show --name-only --pretty=format: ${sha}`, 20)
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean)
    } catch {
      files = []
    }
    try {
      patch = run(`git show --pretty=format: --unified=0 --no-color ${sha}`, 80)
    } catch {
      patch = ''
    }
    commits.push(analyzeCommit({ sha, subject, date, files, patch }))
  }

  const suspicious = commits.filter((commit) =>
    commit.findings.some((finding) => !finding.startsWith('automation_commit_')) ||
    commit.findings.includes('automation_commit_codeguard') ||
    commit.findings.includes('automation_commit_cursor'),
  )

  const report = {
    generated_at: new Date().toISOString(),
    total_commits: commits.length,
    suspicious_count: suspicious.length,
    commits,
    suspicious,
  }
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2))

  console.log(`AUDIT_WRITTEN ${outPath}`)
  console.log(`TOTAL ${report.total_commits}`)
  console.log(`SUSPICIOUS ${report.suspicious_count}`)
}

main()
