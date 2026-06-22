import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..', '..')

const contractPath = path.join(
  rootDir,
  'backend',
  'services',
  'shared',
  'crawlerOpportunityContract.js',
)
const contractUrl = pathToFileURL(contractPath).href
const { isValidHttpUrl, isLoanOrMatchingFund } = await import(contractUrl)

// ─── isValidHttpUrl ─────────────────────────────────────────────

test('isValidHttpUrl: accepts valid https URL', () => {
  assert.equal(isValidHttpUrl('https://www.grants.gov/search'), true)
})

test('isValidHttpUrl: accepts valid http URL', () => {
  assert.equal(isValidHttpUrl('http://communityactionpartnership.com/find-a-cap/'), true)
})

test('isValidHttpUrl: rejects ftp URL', () => {
  assert.equal(isValidHttpUrl('ftp://files.example.org/data'), false)
})

test('isValidHttpUrl: rejects empty string', () => {
  assert.equal(isValidHttpUrl(''), false)
})

test('isValidHttpUrl: rejects null', () => {
  assert.equal(isValidHttpUrl(null), false)
})

test('isValidHttpUrl: rejects non-URL string', () => {
  assert.equal(isValidHttpUrl('not-a-url'), false)
})

test('isValidHttpUrl: rejects example.com placeholder', () => {
  assert.equal(isValidHttpUrl('https://example.com/grant'), false)
})

test('isValidHttpUrl: rejects example.org placeholder', () => {
  assert.equal(isValidHttpUrl('https://example.org/sam/1'), false)
})

test('isValidHttpUrl: rejects example.gov placeholder', () => {
  assert.equal(isValidHttpUrl('https://example.gov/program'), false)
})

test('isValidHttpUrl: rejects URL containing placeholder in hostname', () => {
  assert.equal(isValidHttpUrl('http://placeholder/grant'), false)
})

test('isValidHttpUrl: rejects subdomain of example.com', () => {
  assert.equal(isValidHttpUrl('https://sub.example.com/test'), false)
})

// ─── isLoanOrMatchingFund ────────────────────────────────────────

test('isLoanOrMatchingFund: returns false for normal grant', () => {
  assert.equal(
    isLoanOrMatchingFund({
      title: 'Community Development Grant',
      description: 'Funding for neighborhood improvements',
      opportunity_type: 'grant',
      is_loan: false,
      requires_match: false,
    }),
    false,
  )
})

test('isLoanOrMatchingFund: detects is_loan flag', () => {
  assert.equal(
    isLoanOrMatchingFund({
      title: 'Small Business Program',
      description: 'Supports local businesses',
      opportunity_type: 'grant',
      is_loan: true,
    }),
    true,
  )
})

test('isLoanOrMatchingFund: detects requires_match flag', () => {
  assert.equal(
    isLoanOrMatchingFund({
      title: 'Infrastructure Matching Grant',
      description: 'Requires cost-sharing from applicant',
      opportunity_type: 'grant',
      requires_match: true,
    }),
    true,
  )
})

test('isLoanOrMatchingFund: detects loan opportunity_type', () => {
  assert.equal(
    isLoanOrMatchingFund({
      title: 'Microloan Initiative',
      description: 'Provides capital to small businesses',
      opportunity_type: 'loan',
      is_loan: false,
      requires_match: false,
    }),
    true,
  )
})

test('isLoanOrMatchingFund: detects microloan opportunity_type', () => {
  assert.equal(
    isLoanOrMatchingFund({
      title: 'Emergency Microloan Program',
      description: 'Quick capital access',
      opportunity_type: 'microloan',
    }),
    true,
  )
})

test('isLoanOrMatchingFund: detects loan keyword in title', () => {
  assert.equal(
    isLoanOrMatchingFund({
      title: 'Business Loan Fund',
      description: 'Access capital through a revolving loan fund',
    }),
    true,
  )
})

test('isLoanOrMatchingFund: detects financing keyword in description', () => {
  assert.equal(
    isLoanOrMatchingFund({
      title: 'Growth Capital Program',
      description: 'Provides financing to qualified businesses',
    }),
    true,
  )
})

test('isLoanOrMatchingFund: detects matching funds keyword', () => {
  assert.equal(
    isLoanOrMatchingFund({
      title: 'Community Matching Grant',
      description: 'Applicants must provide matching funds from local sources',
    }),
    true,
  )
})

test('isLoanOrMatchingFund: detects cost share keyword', () => {
  assert.equal(
    isLoanOrMatchingFund({
      title: 'Infrastructure Grant',
      description: 'A 50% cost share is required for all awards',
    }),
    true,
  )
})

test('isLoanOrMatchingFund: returns false for null input', () => {
  assert.equal(isLoanOrMatchingFund(null), false)
})

test('isLoanOrMatchingFund: returns false for empty object', () => {
  assert.equal(isLoanOrMatchingFund({}), false)
})

test('isLoanOrMatchingFund: does not false-positive on "loanable" equipment grant', () => {
  // "loanable" contains "loan" but as part of another word -- regex uses \b word boundary
  assert.equal(
    isLoanOrMatchingFund({
      title: 'Loanable Equipment Program',
      description: 'Equipment available for loanable use by nonprofits',
      opportunity_type: 'grant',
    }),
    false,
  )
})
