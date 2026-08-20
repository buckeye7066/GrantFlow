/**
 * The serial ("isolated") Vitest lanes describe reality.
 *
 * `npm run unit` runs Vitest twice: the bulk lane with two `--exclude` globs,
 * then the OTP family serially by NAME PREFIX. With `passWithNoTests: true`
 * (vitest.config.js) a prefix lane that matches nothing prints
 * "No test files found, exiting with code 0" and EXITS 0 — measured on
 * origin/main 2fcb599f. Renaming or moving an OTP suite therefore used to drop
 * it out of the serial lane with no signal at all, and nothing tied the
 * --exclude list to the include filters, so the two halves could drift apart.
 *
 * This suite is the teeth: it runs in the BULK lane (its own name does not
 * start with `otp`), so a renamed OTP suite reddens `npm run unit` even before
 * the serial lane is reached, and `assertLaneIntegrity` refuses to spawn Vitest
 * for a lane that resolves to the wrong set.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  ISOLATED_LANES,
  VITEST_EXCLUDE_GLOBS,
  VITEST_INCLUDE_GLOBS,
  assertLaneIntegrity,
  checkLane,
  findLaneByExcludeGlobs,
  findLaneByFilters,
  globRoot,
  globToRegExp,
  listTestFiles,
  parseVitestArgs,
  resolveByExcludeGlobs,
  resolveByFilters,
} from '../../scripts/isolated-test-lanes.mjs'
import vitestConfig from '../../vitest.config.js'

const repoRoot = process.cwd()
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))

describe('isolated test lanes', () => {
  it('declares at least one lane, and every declared file exists', () => {
    expect(ISOLATED_LANES.length).toBeGreaterThan(0)
    for (const lane of ISOLATED_LANES) {
      expect(lane.files.length, `lane "${lane.id}" declares no files`).toBeGreaterThan(0)
      for (const file of lane.files) {
        expect(fs.existsSync(path.join(repoRoot, file)), `${file} (lane "${lane.id}") does not exist`).toBe(true)
      }
    }
  })

  it.each(ISOLATED_LANES.map((lane) => [lane.id, lane]))(
    'lane "%s": include filters, --exclude globs and the declared file set all agree',
    (_id, lane) => {
      expect(checkLane(lane, repoRoot)).toEqual([])
    },
  )

  it('the package.json `unit` script still drives the lanes this file declares', () => {
    const unit = String(pkg.scripts.unit)
    for (const lane of ISOLATED_LANES) {
      for (const glob of lane.excludeGlobs) {
        expect(unit, `package.json unit script no longer excludes ${glob}`).toContain(glob)
      }
      for (const filter of lane.filters) {
        expect(unit, `package.json unit script no longer runs the serial filter ${filter}`).toContain(filter)
      }
    }
  })

  it('a RENAMED suite is caught — the exact failure this guard exists for', () => {
    const lane = ISOLATED_LANES[0]
    const renamed = listTestFiles(repoRoot).map((file) =>
      file === lane.files[0] ? file.replace(/([^/]+)\.test\.js$/, 'renamed$1.test.js') : file,
    )
    const problems = checkLane(lane, repoRoot, renamed.sort())
    expect(problems.length, 'a renamed suite must break the lane').toBeGreaterThan(0)
    expect(problems.join('\n')).toMatch(/resolve to|no longer exist/)
  })

  it('a NEW sibling suite that nobody added to the lane is caught in BOTH directions', () => {
    const lane = ISOLATED_LANES[0]
    const withNewSuite = [...listTestFiles(repoRoot), 'backend/tests/otpBrandNewGuard.test.js'].sort()
    const problems = checkLane(lane, repoRoot, withNewSuite)
    // The include filter and the exclude glob both pick it up; the declared
    // list does not — so the lane is stale in both halves.
    expect(problems.length).toBeGreaterThan(0)
    expect(resolveByFilters(lane.filters, repoRoot, withNewSuite)).toContain('backend/tests/otpBrandNewGuard.test.js')
    expect(resolveByExcludeGlobs(lane.excludeGlobs, repoRoot, withNewSuite)).toContain(
      'backend/tests/otpBrandNewGuard.test.js',
    )
  })

  it('a filter that matches NOTHING is refused instead of silently passing', () => {
    const problems = assertLaneIntegrity(['run', '--no-file-parallelism', 'backend/tests/otpNoSuchSuite'])
    expect(problems.length).toBe(1)
    expect(problems[0]).toMatch(/matches NO test file/)
  })

  it('the real lane invocations from package.json and release-gates are accepted', () => {
    const lane = ISOLATED_LANES[0]
    expect(assertLaneIntegrity(['run', '--no-file-parallelism', ...lane.filters])).toEqual([])
    expect(assertLaneIntegrity(['run', ...lane.excludeGlobs.flatMap((g) => ['--exclude', g])])).toEqual([])
    expect(assertLaneIntegrity(['run', 'backend/tests/matching-pipeline.test.js', '--reporter=verbose'])).toEqual([])
    // `--config` takes a VALUE; its argument must never be read as a filter.
    expect(assertLaneIntegrity(['run', '--config', 'vitest.endpoints.config.js'])).toEqual([])
  })

  it('argv parsing separates subcommands, value-flags and positional filters', () => {
    expect(parseVitestArgs(['run', '--no-file-parallelism', 'a', 'b'])).toEqual({
      filters: ['a', 'b'],
      excludes: [],
    })
    expect(parseVitestArgs(['run', '--exclude', 'x.test.js', '--exclude=y.test.js'])).toEqual({
      filters: [],
      excludes: ['x.test.js', 'y.test.js'],
    })
    expect(parseVitestArgs(['run', '--config', 'vitest.endpoints.config.js'])).toEqual({
      filters: [],
      excludes: [],
    })
    expect(parseVitestArgs(['run', '-t', 'some name', 'file.test.js'])).toEqual({
      filters: ['file.test.js'],
      excludes: [],
    })
  })

  it('lane lookup is by SET, not by order', () => {
    const lane = ISOLATED_LANES[0]
    expect(findLaneByFilters([...lane.filters].reverse())).toBe(lane)
    expect(findLaneByExcludeGlobs([...lane.excludeGlobs].reverse())).toBe(lane)
    expect(findLaneByFilters(['backend/tests/otp'])).toBe(null)
  })

  it('discovery mirrors vitest.config.js EXACTLY (drift tripwire)', () => {
    // An approximation here re-opens the hole this guard closes: a filter that
    // resolves to files WE collect but Vitest does not would pass the guard and
    // then exit 0 under passWithNoTests, running nothing.
    expect([...VITEST_INCLUDE_GLOBS]).toEqual(vitestConfig.test.include)
    for (const glob of VITEST_EXCLUDE_GLOBS) {
      expect(vitestConfig.test.exclude, `${glob} is no longer excluded by vitest.config.js`).toContain(glob)
    }
  })

  it('node:test suites under tests/unit are NOT treated as Vitest files', () => {
    // tests/unit/**/*.test.mjs belong to scripts/run-unit-tests.mjs; Vitest's
    // include is `tests/unit/**/*.test.js` only.
    const files = listTestFiles(repoRoot)
    expect(files.some((f) => f.startsWith('tests/unit/') && f.endsWith('.mjs'))).toBe(false)
    expect(files.some((f) => f.startsWith('tests/unit/') && f.endsWith('.test.js'))).toBe(true)

    const nodeTestSuite = fs
      .readdirSync(path.join(repoRoot, 'tests/unit'))
      .find((name) => name.endsWith('.test.mjs'))
    expect(nodeTestSuite, 'expected at least one node:test suite under tests/unit').toBeTruthy()
    const problems = assertLaneIntegrity(['run', `tests/unit/${nodeTestSuite.replace(/\.test\.mjs$/, '')}`])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/matches NO test file/)
  })

  it('the vitest `exclude` entry is honored, so a filter resolving only to it is refused', () => {
    expect(listTestFiles(repoRoot)).not.toContain('backend/tests/endpointSweep.test.js')
    const problems = assertLaneIntegrity(['run', 'backend/tests/endpointSweep'])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/matches NO test file/)
  })

  it('globRoot finds the literal prefix of each include glob', () => {
    expect(globRoot('src/**/*.test.{js,jsx}')).toBe('src')
    expect(globRoot('backend/tests/**/*.test.{js,mjs}')).toBe('backend/tests')
    expect(globRoot('tests/unit/**/*.test.js')).toBe('tests/unit')
  })

  it('globToRegExp: * does not cross directories, ** does, {a,b} alternates', () => {
    const star = globToRegExp('backend/tests/otp*.test.js')
    expect(star.test('backend/tests/otpLockoutBypass.test.js')).toBe(true)
    expect(star.test('backend/tests/otp/nested.test.js')).toBe(false)
    expect(star.test('backend/tests/emailOtpTokenNoVerifier.test.js')).toBe(false)
    const globstar = globToRegExp('backend/**/*.test.js')
    expect(globstar.test('backend/tests/otpLockoutBypass.test.js')).toBe(true)
    expect(globstar.test('backend/tests/deep/nested.test.js')).toBe(true)

    const braces = globToRegExp('backend/tests/**/*.test.{js,mjs}')
    expect(braces.test('backend/tests/a.test.js')).toBe(true)
    expect(braces.test('backend/tests/a.test.mjs')).toBe(true)
    expect(braces.test('backend/tests/a.test.jsx')).toBe(false)
    expect(globToRegExp('tests/unit/**/*.test.js').test('tests/unit/a.test.mjs')).toBe(false)
  })
})
