/**
 * scripts/isolated-test-lanes.mjs
 *
 * The DECLARED inventory of Vitest suites that `npm run unit` deliberately
 * splits out of the parallel lane and runs serially, plus the machinery that
 * proves the split still describes reality.
 *
 * ## Why this file exists
 *
 * `npm run unit` runs Vitest twice:
 *
 *   1. the bulk lane, with `--exclude "backend/tests/otp*.test.js"
 *      --exclude "backend/tests/emailOtpTokenNoVerifier.test.js"`
 *   2. the serial lane, with the bare NAME PREFIXES
 *      `backend/tests/otp backend/tests/emailOtpTokenNoVerifier`
 *
 * Those are two hand-maintained lists in package.json with nothing tying them
 * together, and `vitest.config.js` sets `passWithNoTests: true`. Measured on
 * origin/main 2fcb599f: a serial lane whose filters match nothing prints
 * "No test files found, exiting with code 0" and EXITS 0. So renaming or
 * moving an OTP suite silently drops it out of the serial lane — or, if both
 * lists drift apart, drops it out of BOTH — and the gate stays green while the
 * suites it exists to run have vanished.
 *
 * ## What the guard asserts
 *
 * For a DECLARED lane (matched by its filter list or its exclude list):
 *   - every declared file still exists on disk
 *   - the include filters resolve to EXACTLY the declared file set
 *   - the exclude globs resolve to EXACTLY the same set
 *   so the two halves cannot drift apart, and a rename fails BOTH lanes.
 *
 * For any UNDECLARED positional filter (e.g. release-gates' single-file runs):
 *   - each filter must resolve to at least one test file
 *   so no name-prefix lane can ever again match nothing and report success.
 *
 * Vitest positional filters are SUBSTRING matches against the posix-relative
 * test file path, which is what `resolveByFilters` reproduces.
 */

import fs from 'node:fs'
import path from 'node:path'

/**
 * The EXACT `include`/`exclude` patterns from vitest.config.js.
 *
 * These must mirror that file, not merely approximate it, and
 * backend/tests/isolatedTestLanes.test.js imports the real config and asserts
 * they are equal. A looser pattern here re-opens the very hole this guard
 * closes: `tests/unit/**\/*.test.mjs` are node:test suites run by
 * scripts/run-unit-tests.mjs and Vitest deliberately does NOT collect them, so
 * a discovery that matched `.mjs` under tests/unit would report "this filter
 * matches files" for a lane Vitest resolves to zero and exits 0 on.
 */
export const VITEST_INCLUDE_GLOBS = Object.freeze([
  'src/**/*.test.{js,jsx}',
  'backend/tests/**/*.test.{js,mjs}',
  'tests/unit/**/*.test.js',
])

export const VITEST_EXCLUDE_GLOBS = Object.freeze(['backend/tests/endpointSweep.test.js'])

/** The literal directory prefix of a glob, i.e. everything before the first wildcard. */
export function globRoot(glob) {
  const wildcard = glob.search(/[*?{[]/)
  const head = wildcard === -1 ? glob : glob.slice(0, wildcard)
  const cut = head.lastIndexOf('/')
  return cut === -1 ? '.' : head.slice(0, cut)
}

export const DEFAULT_SEARCH_ROOTS = Object.freeze([
  ...new Set(VITEST_INCLUDE_GLOBS.map(globRoot)),
])

export const ISOLATED_LANES = Object.freeze([
  Object.freeze({
    id: 'otp',
    reason:
      'The OTP full-app family races its OWN parallel requests in-process (the security ' +
      'property under test), so cross-FILE parallelism adds only CPU-starvation noise.',
    // package.json `unit`, third command (positional filters).
    filters: Object.freeze(['backend/tests/otp', 'backend/tests/emailOtpTokenNoVerifier']),
    // package.json `unit`, second command (--exclude values).
    excludeGlobs: Object.freeze([
      'backend/tests/otp*.test.js',
      'backend/tests/emailOtpTokenNoVerifier.test.js',
    ]),
    files: Object.freeze([
      'backend/tests/emailOtpTokenNoVerifier.test.js',
      'backend/tests/otpEmailSendCompensation.test.js',
      'backend/tests/otpLockoutBypass.test.js',
      'backend/tests/otpLoginRetired.test.js',
      'backend/tests/otpPhoneDedupMigration.test.js',
      'backend/tests/otpProfileAdoptionBinding.test.js',
      'backend/tests/otpStartOrdering.test.js',
      'backend/tests/otpVerifyAtomicity.test.js',
    ]),
  }),
])

export function toPosix(p) {
  return String(p).split(path.sep).join('/')
}

/**
 * Every file Vitest would collect under this repo's config: the union of
 * VITEST_INCLUDE_GLOBS minus VITEST_EXCLUDE_GLOBS.
 */
export function listTestFiles(
  cwd = process.cwd(),
  includeGlobs = VITEST_INCLUDE_GLOBS,
  excludeGlobs = VITEST_EXCLUDE_GLOBS,
) {
  const includes = includeGlobs.map(globToRegExp)
  const excludes = excludeGlobs.map(globToRegExp)
  const found = new Set()
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.isFile()) continue
      const rel = toPosix(path.relative(cwd, full))
      if (!includes.some((re) => re.test(rel))) continue
      if (excludes.some((re) => re.test(rel))) continue
      found.add(rel)
    }
  }
  for (const root of new Set(includeGlobs.map(globRoot))) walk(path.resolve(cwd, root))
  return [...found].sort()
}

/**
 * Minimal glob -> RegExp for the shapes used here: `**` crosses directories,
 * `*` and `?` do not, and `{a,b}` is a brace alternation. Deliberately small
 * and self-contained: this runs in CI before any dependency graph is loaded,
 * and picomatch is only a transitive dependency of this repo.
 */
export function globToRegExp(glob) {
  let out = '^'
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i++
        if (glob[i + 1] === '/') i++
        out += '(?:.*\\/)?'
      } else {
        out += '[^/]*'
      }
      continue
    }
    if (ch === '?') {
      out += '[^/]'
      continue
    }
    if (ch === '{') {
      const close = glob.indexOf('}', i)
      if (close !== -1) {
        const alternatives = glob
          .slice(i + 1, close)
          .split(',')
          .map((alt) => alt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        out += `(?:${alternatives.join('|')})`
        i = close
        continue
      }
    }
    out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`${out}$`)
}

export function resolveByFilters(filters, cwd = process.cwd(), files = listTestFiles(cwd)) {
  const matched = new Set()
  for (const filter of filters) {
    const needle = toPosix(filter)
    for (const file of files) {
      if (file.includes(needle)) matched.add(file)
    }
  }
  return [...matched].sort()
}

export function resolveByExcludeGlobs(globs, cwd = process.cwd(), files = listTestFiles(cwd)) {
  const patterns = globs.map(globToRegExp)
  return files.filter((file) => patterns.some((re) => re.test(file))).sort()
}

function sameSet(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

function sameList(a, b) {
  return sameSet([...a].sort(), [...b].sort())
}

export function findLaneByFilters(filters) {
  return ISOLATED_LANES.find((lane) => sameList(lane.filters, filters)) || null
}

export function findLaneByExcludeGlobs(globs) {
  return ISOLATED_LANES.find((lane) => sameList(lane.excludeGlobs, globs)) || null
}

/**
 * Returns a list of human-readable problems. Empty list == the lane still
 * describes reality.
 */
export function checkLane(lane, cwd = process.cwd(), files = listTestFiles(cwd)) {
  const problems = []
  const declared = [...lane.files].sort()

  if (declared.length === 0) {
    problems.push(`lane "${lane.id}" declares no files at all`)
    return problems
  }

  const missing = declared.filter((file) => !fs.existsSync(path.resolve(cwd, file)))
  if (missing.length) {
    problems.push(
      `lane "${lane.id}" declares ${missing.length} file(s) that no longer exist: ${missing.join(', ')}. ` +
        'A renamed or moved suite must be renamed in scripts/isolated-test-lanes.mjs too.',
    )
  }

  const byFilter = resolveByFilters(lane.filters, cwd, files)
  if (!sameSet(byFilter, declared)) {
    problems.push(
      `lane "${lane.id}" include filters [${lane.filters.join(', ')}] resolve to ${byFilter.length} file(s) ` +
        `but ${declared.length} are declared.\n    only-resolved: ${byFilter.filter((f) => !declared.includes(f)).join(', ') || '(none)'}` +
        `\n    only-declared: ${declared.filter((f) => !byFilter.includes(f)).join(', ') || '(none)'}`,
    )
  }

  const byExclude = resolveByExcludeGlobs(lane.excludeGlobs, cwd, files)
  if (!sameSet(byExclude, declared)) {
    problems.push(
      `lane "${lane.id}" exclude globs [${lane.excludeGlobs.join(', ')}] resolve to ${byExclude.length} file(s) ` +
        `but ${declared.length} are declared — the bulk lane and the serial lane have DRIFTED.` +
        `\n    only-excluded: ${byExclude.filter((f) => !declared.includes(f)).join(', ') || '(none)'}` +
        `\n    only-declared: ${declared.filter((f) => !byExclude.includes(f)).join(', ') || '(none)'}`,
    )
  }

  return problems
}

/** Vitest flags that consume the NEXT argv entry as their value. */
export const VALUE_FLAGS = Object.freeze(
  new Set([
    '-c', '--config', '--exclude', '--include', '--dir', '--root', '--reporter', '--outputFile',
    '--project', '--shard', '--pool', '--environment', '--retry', '--bail', '--mode',
    '--testTimeout', '--hookTimeout', '--teardownTimeout', '--slowTestThreshold',
    '--maxWorkers', '--minWorkers', '--maxConcurrency', '--cache.dir', '--coverage.reporter',
    '-t', '--testNamePattern', '--changed', '--browser.name',
  ]),
)

const SUBCOMMANDS = new Set(['run', 'watch', 'dev', 'related', 'bench', 'typecheck', 'list', 'init'])

/** Splits a Vitest argv into its positional filters and its --exclude values. */
export function parseVitestArgs(argv) {
  const filters = []
  const excludes = []
  let sawSubcommand = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') continue
    if (arg.startsWith('-')) {
      const eq = arg.indexOf('=')
      if (eq !== -1) {
        const name = arg.slice(0, eq)
        if (name === '--exclude') excludes.push(arg.slice(eq + 1))
        continue
      }
      if (VALUE_FLAGS.has(arg)) {
        const value = argv[i + 1]
        if (arg === '--exclude' && value !== undefined) excludes.push(value)
        i++
      }
      continue
    }
    if (!sawSubcommand && SUBCOMMANDS.has(arg)) {
      sawSubcommand = true
      continue
    }
    filters.push(arg)
  }
  return { filters, excludes }
}

/**
 * The guard `scripts/run-vitest-isolated.mjs` runs before spawning Vitest.
 * Returns a list of problems; empty == safe to run.
 */
export function assertLaneIntegrity(argv, cwd = process.cwd()) {
  const { filters, excludes } = parseVitestArgs(argv)
  if (!filters.length && !excludes.length) return []

  const files = listTestFiles(cwd)
  const problems = []

  if (filters.length) {
    const lane = findLaneByFilters(filters)
    if (lane) {
      problems.push(...checkLane(lane, cwd, files))
    } else {
      for (const filter of filters) {
        if (resolveByFilters([filter], cwd, files).length === 0) {
          problems.push(
            `positional filter "${filter}" matches NO test file. Vitest's passWithNoTests would ` +
              'report success for a lane that ran nothing — refusing to run.',
          )
        }
      }
    }
  }

  if (excludes.length) {
    const lane = findLaneByExcludeGlobs(excludes)
    if (lane) problems.push(...checkLane(lane, cwd, files))
  }

  return [...new Set(problems)]
}
