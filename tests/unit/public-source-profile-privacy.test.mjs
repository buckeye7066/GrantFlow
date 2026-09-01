import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import pdfParse from 'pdf-parse'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..')
const execFileAsync = promisify(execFile)

const fragment = (...parts) => parts.join('')
const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const splitNamePattern = (parts) => parts.map(escaped).join('[^a-z0-9]+')

const LEGACY = Object.freeze({
  studentGiven: fragment('ana', 'stasia'),
  seniorGiven: fragment('ava', 'nell'),
  seniorMedicalGiven: fragment('lui', 'bov'),
  seniorMedicalAlternate: fragment('liu', 'bov'),
  privateWindowsUser: fragment('fir', 'er'),
  privateMailboxAlias: fragment('fir', 'er', 'ookie_74'),
  privatePaymentAlias: fragment('jwhite', 'rnmba'),
})

// The GitHub owner token is intentionally public in repository URLs, CODEOWNERS,
// and release metadata. Business-domain addresses are also approved routing
// placeholders. Neither policy permits an owner personal-mailbox default or an
// owner identity joined to private health/profile facts.
const PUBLIC_GITHUB_OWNER = fragment('buckeye', '7066')
const APPROVED_BUSINESS_ROUTING_DOMAIN = fragment('axiom', 'biolabs.org')
const PUBLIC_OWNER_NAME = [fragment('jo', 'hn'), fragment('wh', 'ite')].join(' ')

// THIS GATE HAS NO ALLOWLIST, AND MUST NEVER GROW ONE.
//
// On 2026-08-29 a FlexFactor `chore(autoclean)` commit (a1defc85) made this test
// pass by adding a `KNOWN_PRIVATE_DATA_ENTRIES` array naming the nine files that
// were failing it — eight of its own ~43MB run manifests plus its audit report —
// and filtering them out of `offenders` before the assertion. The private
// Windows account alias stayed in the tree; only the alarm was removed. The
// manifests were later deleted wholesale by f0a6931d, but the allowlist
// survived, so this gate stayed blind to any future file that reproduced one of
// those paths.
//
// The correct response to this test failing is to REMOVE THE PRIVATE DATA from
// the offending file (and git-ignore it if it is generated), never to name the
// offender here. `offenders` is asserted empty, verbatim.

const LEGACY_PROFILE_PARTS = [
  [[fragment('jo', 'hn')], ['doe']],
  [['axiom'], ['biolabs'], ['2']],
  [[fragment('oli', 'via')], ['beltran']],
  [[LEGACY.seniorGiven], ['leamon']],
  [[fragment('gil', 'bert')], ['mccosh']],
  [[fragment('hol', 'lie')], ['knox']],
  [[fragment('bri', 'an')], ['client']],
  [['focus'], ['forward'], ['ministries']],
  [[fragment('jo', 'hn')], ['white']],
  [[fragment('pa', 'ul')], ['jason'], ['dasher']],
  [[fragment('ange', 'lika')], ['ptak']],
  [[fragment('ra', 'chel')], ['miller']],
  [[LEGACY.studentGiven], ['white']],
  [[fragment('ka', 'thy')], ['daniel']],
  [[fragment('kim', 'berly')], ['botts']],
  [[LEGACY.seniorMedicalGiven], ['samoylenko']],
  [[fragment('rob', 'ert')], ['white']],
  [[fragment('jo', 'sh')], ['dasher']],
  [[fragment('meli', 'ssa')], ['justus']],
  [[fragment('will', 'iam')]],
  [[LEGACY.studentGiven]],
]

const LEGACY_FULL_NAME_PARTS = [
  [[LEGACY.studentGiven], ['nicole'], ['white']],
  [[LEGACY.studentGiven], ['white']],
  [[LEGACY.seniorGiven], ['leamon']],
  [[fragment('gil', 'bert')], ['allen'], ['mccosh']],
  [[fragment('gil', 'bert')], ['mccosh']],
  [[fragment('hol', 'lie')], ['machelle'], ['knox']],
  [[fragment('hol', 'lie')], ['knox']],
  [[fragment('oli', 'via')], ['beltran']],
  [[fragment('pa', 'ul')], ['jason'], ['dasher']],
  [[fragment('ange', 'lika')], ['ptak']],
  [[fragment('ra', 'chel')], ['miller']],
  [[fragment('ka', 'thy')], ['marie'], ['daniel']],
  [[fragment('ka', 'thy')], ['daniel']],
  [[fragment('kim', 'berly')], ['botts']],
  [[LEGACY.seniorMedicalGiven], ['samoylenko']],
  [[LEGACY.seniorMedicalAlternate], ['samoylenko']],
  [[fragment('rob', 'ert')], ['white']],
  [[fragment('jo', 'sh')], ['dasher']],
  [[fragment('meli', 'ssa')], ['justus']],
]

const BANNED_PUBLIC_MARKERS = [
  ['c4a92724', '9cee', '416f', 'ba30', 'e91b9b5cd885'].join('-'),
  ...LEGACY_PROFILE_PARTS.map(parts => ['profile', ...parts.map(token => token.join(''))].join('-')),
  ...LEGACY_FULL_NAME_PARTS.map(parts => parts.map(token => token.join('')).join(' ')),
  [fragment('anyawhite'), 'rocketmail.com'].join('@'),
  [fragment('angelikaps.rn'), 'gmail.com'].join('@'),
  [fragment('nitaboatdrink'), 'hotmail.com'].join('@'),
  [LEGACY.privateMailboxAlias, 'yahoo.com'].join('@'),
  [LEGACY.privatePaymentAlias, 'yahoo.com'].join('@'),
  fragment('Tennessee', '93!'),
  ['ROBERT', 'YAHOO', fragment('FIR', 'ER', 'OOKIE74'), 'APP', 'PASSWORD'].join('_'),
  ['ROBERT', 'YAHOO', 'JWHITE', 'RNMBA', 'APP', 'PASSWORD'].join('_'),
]

const exactPatterns = BANNED_PUBLIC_MARKERS.map((marker) => ({
  label: 'known private profile marker',
  expression: new RegExp(escaped(marker), 'i'),
}))

const splitFullNames = LEGACY_FULL_NAME_PARTS
  .map(parts => splitNamePattern(parts.map(token => token.join(''))))
  .join('|')
const distinctiveGivenNames = [
  LEGACY.studentGiven,
  LEGACY.seniorGiven,
  LEGACY.seniorMedicalGiven,
  LEGACY.seniorMedicalAlternate,
].map(escaped).join('|')
const ownerFullNamePattern = splitNamePattern([fragment('jo', 'hn'), fragment('wh', 'ite')])
const sensitiveFactPattern = [
  'arthritis',
  'disability',
  'medical',
  'diagnosis',
  'health',
  'income',
  'widow',
  'veteran',
].join('|')

const BANNED_PUBLIC_PATTERNS = [
  ...exactPatterns,
  {
    label: 'distinctive legacy given-name marker',
    expression: new RegExp(`(?:^|[^a-z])(?:${distinctiveGivenNames})`, 'i'),
  },
  {
    label: 'split or tokenized legacy full name',
    expression: new RegExp(`\\b(?:${splitFullNames})\\b`, 'i'),
  },
  {
    label: 'private Windows account or mailbox alias',
    expression: new RegExp(`\\b${escaped(LEGACY.privateWindowsUser)}(?:${escaped('rookie')}(?:_?74)?)?\\b`, 'i'),
  },
  {
    label: 'owner personal Gmail default (including plus-address)',
    expression: new RegExp(`\\b${escaped(PUBLIC_GITHUB_OWNER)}(?:\\+[^@\\s]+)?@gmail\\.com\\b`, 'i'),
  },
  {
    label: 'retired private payment alias',
    expression: new RegExp(`\\b${escaped(LEGACY.privatePaymentAlias)}\\b`, 'i'),
  },
  {
    label: 'public owner identity joined to a sensitive profile fact',
    expression: new RegExp(`\\b${ownerFullNamePattern}\\b[\\s\\S]{0,200}\\b(?:${sensitiveFactPattern})\\b`, 'i'),
  },
  {
    label: 'sensitive profile fact joined to the public owner identity',
    expression: new RegExp(`\\b(?:${sensitiveFactPattern})\\b[\\s\\S]{0,200}\\b${ownerFullNamePattern}\\b`, 'i'),
  },
]

const removedScript = (...parts) => parts.join('-')
const REMOVED_PROFILE_SPECIFIC_SCRIPTS = [
  ['backend', 'scripts', removedScript('fix', LEGACY.studentGiven, 'profile.mjs')].join('/'),
  ['backend', 'scripts', removedScript('create', `${LEGACY.studentGiven}.mjs`)].join('/'),
  ['backend', 'scripts', removedScript('read', LEGACY.studentGiven, 'vision.mjs')].join('/'),
  ['backend', 'scripts', removedScript('process', LEGACY.studentGiven, 'ai.mjs')].join('/'),
  ['backend', 'scripts', 'cleanup-profiles.mjs'].join('/'),
  ['scripts', removedScript(LEGACY.studentGiven, 'fix', 'cycle', 'and', 'add', 'july', 'bridge.mjs')].join('/'),
  ['scripts', removedScript('cleanup', LEGACY.studentGiven, 'pipeline', 'goal', 'fit.mjs')].join('/'),
  ['scripts', removedScript(LEGACY.studentGiven, 'july', 'actionable', 'list.mjs')].join('/'),
  ['scripts', removedScript('test', 'mtsu', 'sync', `${LEGACY.studentGiven}.mjs`)].join('/'),
  ['scripts', removedScript('cleanup', LEGACY.seniorGiven, 'pipeline.mjs')].join('/'),
  ['scripts', 'reattach-users-to-profiles.mjs'].join('/'),
]

const BINARY_EXTENSIONS = new Set([
  '.7z', '.avif', '.db', '.docx', '.eot', '.gif', '.gz', '.ico', '.jpeg', '.jpg',
  '.mp3', '.mp4', '.otf', '.pdf', '.png', '.sqlite', '.tar', '.ttf', '.wav',
  '.webm', '.webp', '.woff', '.woff2', '.xlsx', '.zip',
])

function isLikelyBinary(buffer) {
  if (buffer.includes(0)) return true
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192))
  if (sample.length === 0) return false
  let controlBytes = 0
  for (const byte of sample) {
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 12 && byte !== 13) controlBytes += 1
  }
  return controlBytes / sample.length > 0.01
}

async function gitVisibleFiles() {
  const { stdout } = await execFileAsync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  return stdout.split('\0').filter(Boolean)
}

function matchingPolicies(source) {
  return BANNED_PUBLIC_PATTERNS.filter(({ expression }) => expression.test(source))
}

test('public source tree contains no known real-profile identifier or full-name marker', async () => {
  const offenders = []
  for (const relative of await gitVisibleFiles()) {
    if (BINARY_EXTENSIONS.has(path.extname(relative).toLowerCase())) continue
    let buffer
    try {
      buffer = await fs.readFile(path.join(REPO_ROOT, relative))
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    if (isLikelyBinary(buffer)) continue
    const source = buffer.toString('utf8')
    for (const { label, expression } of matchingPolicies(source)) {
      const match = expression.exec(source)
      const line = source.slice(0, match?.index || 0).split('\n').length
      offenders.push(`${relative}:${line}: ${label}`)
    }
  }
  assert.deepEqual(offenders.sort(), [])
})

test('privacy policy allows public owner metadata and business routing, but rejects personal defaults', () => {
  const allowed = [
    `https://github.com/${PUBLIC_GITHUB_OWNER}/GrantFlow`,
    `${PUBLIC_GITHUB_OWNER} @github-owner`,
    `Dr. ${PUBLIC_OWNER_NAME}, public repository owner`,
    `admin@${APPROVED_BUSINESS_ROUTING_DOMAIN}`,
    `dr.johnwhite@${APPROVED_BUSINESS_ROUTING_DOMAIN}`,
  ]
  for (const source of allowed) assert.deepEqual(matchingPolicies(source), [])

  const privateOwnerDefault = `${PUBLIC_GITHUB_OWNER}+crawler@gmail.com`
  assert.equal(matchingPolicies(privateOwnerDefault).length, 1)

  const tokenizedLegacyName = [LEGACY.studentGiven, 'Nicole', 'White'].join("', '")
  assert.ok(matchingPolicies(tokenizedLegacyName).length > 0)
  assert.ok(matchingPolicies(LEGACY.seniorGiven).length > 0)

  const sensitiveOwnerJoin = `Dr. ${PUBLIC_OWNER_NAME}'s declared arthritis support need`
  assert.ok(matchingPolicies(sensitiveOwnerJoin).length > 0)
})

test('profile-specific production mutation and document-extraction scripts stay removed', async () => {
  const stillPresent = []
  for (const relative of REMOVED_PROFILE_SPECIFIC_SCRIPTS) {
    try {
      await fs.access(path.join(REPO_ROOT, relative))
      stillPresent.push(relative)
    } catch {
      // Expected: real profile operations belong in a private operator surface.
    }
  }
  assert.deepEqual(stillPresent, [])
})

test('tracked payment PDFs exclude retired private aliases and remain synchronized', async () => {
  const pdfPaths = [
    path.join(REPO_ROOT, 'docs', 'Payment sheet Grantflow.pdf'),
    path.join(REPO_ROOT, 'public', 'docs', 'Payment_sheet_Grantflow.pdf'),
  ]
  const buffers = await Promise.all(pdfPaths.map((pdfPath) => fs.readFile(pdfPath)))
  assert.ok(buffers[0].equals(buffers[1]), 'docs and public payment PDFs must be identical')

  for (const [index, buffer] of buffers.entries()) {
    const parsed = await pdfParse(buffer)
    const offenders = matchingPolicies(parsed.text)
      .map(({ label }) => `${path.relative(REPO_ROOT, pdfPaths[index])}: ${label}`)
    assert.deepEqual(offenders, [])
    assert.match(parsed.text, /CashApp:/i)
    assert.match(parsed.text, /\$example-payment-handle/i)
  }
})
