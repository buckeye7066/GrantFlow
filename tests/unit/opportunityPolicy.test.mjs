/**
 * Unit tests for opportunityPolicy.js
 * Tests: isLoanLike, isMatchingFunds, isPlaceholderOpportunity, isValidRealUrl,
 *        enforceOpportunityPolicy, rejection counters
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const modulePath = path.resolve(__dirname, '..', '..', 'backend', 'services', 'shared', 'opportunityPolicy.js')
const moduleUrl = pathToFileURL(modulePath).href

const {
  isLoanLike,
  isMatchingFunds,
  isPlaceholderOpportunity,
  isValidRealUrl,
  pickRealUrl,
  enforceOpportunityPolicy,
  getPolicyRejectionCounts,
  resetPolicyRejectionCounts,
} = await import(moduleUrl)

// ─── isValidRealUrl ──────────────────────────────────────────────────────────

test('isValidRealUrl: accepts valid https URL', () => {
  assert.equal(isValidRealUrl('https://grants.gov/search'), true)
})

test('isValidRealUrl: accepts valid http URL', () => {
  assert.equal(isValidRealUrl('http://communityactionpartnership.com/find-a-cap/'), true)
})

test('isValidRealUrl: rejects null', () => {
  assert.equal(isValidRealUrl(null), false)
})

test('isValidRealUrl: rejects empty string', () => {
  assert.equal(isValidRealUrl(''), false)
})

test('isValidRealUrl: rejects ftp scheme', () => {
  assert.equal(isValidRealUrl('ftp://files.example.org/data'), false)
})

test('isValidRealUrl: rejects example.com', () => {
  assert.equal(isValidRealUrl('https://example.com/grant'), false)
})

test('isValidRealUrl: rejects example.org', () => {
  assert.equal(isValidRealUrl('https://example.org/sam/1'), false)
})

test('isValidRealUrl: rejects example.gov', () => {
  assert.equal(isValidRealUrl('https://example.gov/program'), false)
})

test('isValidRealUrl: rejects localhost', () => {
  assert.equal(isValidRealUrl('http://localhost:3000/api'), false)
})

test('isValidRealUrl: rejects 127.0.0.1', () => {
  assert.equal(isValidRealUrl('http://127.0.0.1/grant'), false)
})

test('isValidRealUrl: rejects subdomain of example.com', () => {
  assert.equal(isValidRealUrl('https://sub.example.com/test'), false)
})

// ─── pickRealUrl ─────────────────────────────────────────────────────────────

test('pickRealUrl: picks url field first', () => {
  assert.equal(
    pickRealUrl({ url: 'https://grants.gov/1', source_url: 'https://grants.gov/2' }),
    'https://grants.gov/1',
  )
})

test('pickRealUrl: falls back to application_url', () => {
  assert.equal(pickRealUrl({ application_url: 'https://grants.gov/2' }), 'https://grants.gov/2')
})

test('pickRealUrl: returns null for placeholder URL', () => {
  assert.equal(pickRealUrl({ url: 'https://example.com/grant' }), null)
})

test('pickRealUrl: returns null for empty object', () => {
  assert.equal(pickRealUrl({}), null)
})

// ─── isLoanLike ──────────────────────────────────────────────────────────────

test('isLoanLike: returns false for normal grant', () => {
  assert.equal(
    isLoanLike({ title: 'Community Development Grant', description: 'Funding for programs', opportunity_type: 'grant' }),
    false,
  )
})

test('isLoanLike: detects is_loan flag', () => {
  assert.equal(isLoanLike({ title: 'Program', description: 'Supports businesses', is_loan: true }), true)
})

test('isLoanLike: detects opportunity_type loan', () => {
  assert.equal(isLoanLike({ title: 'Business Program', description: 'Capital access', opportunity_type: 'loan' }), true)
})

test('isLoanLike: detects microloan opportunity_type', () => {
  assert.equal(isLoanLike({ title: 'Emergency Program', description: 'Quick capital', opportunity_type: 'microloan' }), true)
})

test('isLoanLike: detects loan keyword in title', () => {
  assert.equal(isLoanLike({ title: 'Revolving Loan Fund', description: 'Access capital' }), true)
})

test('isLoanLike: detects loan program in description', () => {
  assert.equal(isLoanLike({ title: 'Growth Program', description: 'This small business loan program provides capital' }), true)
})

test('isLoanLike: does NOT false-positive on standalone "financing" keyword', () => {
  // "financing" alone is too broad — grants that provide "alternatives to financing" were being rejected
  assert.equal(isLoanLike({ title: 'Growth Program', description: 'Provides financing to businesses' }), false)
})

test('isLoanLike: detects interest rate keyword', () => {
  assert.equal(isLoanLike({ title: 'Capital Program', description: 'Low interest rate available to borrowers' }), true)
})

test('isLoanLike: detects monthly payment keyword', () => {
  assert.equal(isLoanLike({ title: 'Funding Program', description: 'Easy monthly payment plan for businesses' }), true)
})

test('isLoanLike: detects borrower keyword', () => {
  assert.equal(isLoanLike({ title: 'Capital Access', description: 'Requirements for borrower eligibility' }), true)
})

test('isLoanLike: detects repayment of the loan (narrowed from generic "funds")', () => {
  // Fixture uses explicit loan terminology (a promissory note + "repayment
  // of the loan") instead of the old generic "repayment of funds", which
  // matched federal grant clawback language and dropped real grants at the
  // ingest choke point (enforceOpportunityPolicy). See opportunityPolicy.js
  // LOAN_PHRASE_RX for the fix.
  assert.equal(
    isLoanLike({
      title: 'Capital Program',
      description: 'Recipients sign a promissory note; repayment of the loan begins after a 6-month grace period.',
    }),
    true,
  )
})

test('isLoanLike: does NOT false-positive on standard grant clawback language', () => {
  // Regression for the bug the regex narrowing above fixes: federal grant
  // notices routinely warn that funds must be repaid if award conditions are
  // violated. That is clawback language, not a loan product, and must not be
  // classified as loan-like (it was previously being dropped at the ingest
  // choke point via enforceOpportunityPolicy -> isLoanLike).
  assert.equal(
    isLoanLike({
      title: 'Community Health Access Grant',
      description:
        'This is a grant, not a loan. The grantee must make repayment of funds if award conditions are violated or the project is terminated early.',
      opportunity_type: 'grant',
    }),
    false,
  )
})

test('isLoanLike: exempts loan repayment assistance (grants that help repay loans)', () => {
  assert.equal(
    isLoanLike({
      title: 'Student Loan Repayment Assistance',
      description: 'Grant for student loan repayment assistance for healthcare workers',
    }),
    false,
  )
})

test('isLoanLike: exempts loan forgiveness programs', () => {
  assert.equal(
    isLoanLike({
      title: 'Public Service Loan Forgiveness',
      description: 'Loan forgiveness for qualifying public servants',
    }),
    false,
  )
})

test('isLoanLike: does not false-positive on "loanable"', () => {
  assert.equal(
    isLoanLike({ title: 'Equipment Lending Program', description: 'Equipment loanable to nonprofits', opportunity_type: 'grant' }),
    false,
  )
})

test('isLoanLike: returns false for null', () => {
  assert.equal(isLoanLike(null), false)
})

// ─── isMatchingFunds ─────────────────────────────────────────────────────────

test('isMatchingFunds: returns false for normal grant', () => {
  assert.equal(
    isMatchingFunds({ title: 'Infrastructure Grant', description: 'Community development funding for local organizations', requires_match: false }),
    false,
  )
})

test('isMatchingFunds: detects requires_match flag', () => {
  assert.equal(isMatchingFunds({ title: 'Grant', description: 'Requires cost-sharing', requires_match: true }), true)
})

test('isMatchingFunds: detects match_percentage > 0', () => {
  assert.equal(isMatchingFunds({ title: 'Grant', description: 'Program', match_percentage: 50 }), true)
})

test('isMatchingFunds: detects matching funds keyword', () => {
  assert.equal(
    isMatchingFunds({ title: 'Community Grant', description: 'Applicants must provide matching funds from local sources' }),
    true,
  )
})

test('isMatchingFunds: detects cost-share keyword', () => {
  assert.equal(
    isMatchingFunds({ title: 'Infrastructure Grant', description: 'A 50% cost share is required for all awards' }),
    true,
  )
})

test('isMatchingFunds: detects dollar-for-dollar keyword', () => {
  assert.equal(
    isMatchingFunds({ title: 'Matching Program', description: 'Funded dollar-for-dollar by the applicant' }),
    true,
  )
})

test('isMatchingFunds: returns false for null', () => {
  assert.equal(isMatchingFunds(null), false)
})

// ─── isPlaceholderOpportunity ────────────────────────────────────────────────

test('isPlaceholderOpportunity: returns false for real content', () => {
  assert.equal(
    isPlaceholderOpportunity({ title: 'Pell Grant', description: 'Need-based federal grant' }),
    false,
  )
})

test('isPlaceholderOpportunity: detects lorem ipsum in title', () => {
  assert.equal(
    isPlaceholderOpportunity({ title: 'Lorem Ipsum Grant', description: 'Real description' }),
    true,
  )
})

test('isPlaceholderOpportunity: detects "coming soon" in description', () => {
  assert.equal(
    isPlaceholderOpportunity({ title: 'New Program', description: 'Coming soon — details to be announced.' }),
    true,
  )
})

test('isPlaceholderOpportunity: detects missing title', () => {
  assert.equal(isPlaceholderOpportunity({ title: '', description: 'Some description' }), true)
})

test('isPlaceholderOpportunity: detects very short title', () => {
  assert.equal(isPlaceholderOpportunity({ title: 'X', description: 'Some description' }), true)
})

test('isPlaceholderOpportunity: detects "TBD" in title', () => {
  assert.equal(isPlaceholderOpportunity({ title: 'TBD Grant', description: 'Details TBD' }), true)
})

test('isPlaceholderOpportunity: detects "placeholder" keyword', () => {
  assert.equal(isPlaceholderOpportunity({ title: 'Placeholder Opportunity', description: 'placeholder' }), true)
})

test('isPlaceholderOpportunity: returns false for null', () => {
  assert.equal(isPlaceholderOpportunity(null), false)
})

// ─── enforceOpportunityPolicy ────────────────────────────────────────────────

const VALID_GRANT = {
  title: 'Community Development Block Grant',
  description: 'Federal community development funding for local governments',
  url: 'https://www.hud.gov/program_offices/comm_planning/cdbg',
  opportunity_type: 'grant',
  is_loan: false,
  requires_match: false,
}

test('enforceOpportunityPolicy: passes valid grant', () => {
  const result = enforceOpportunityPolicy(VALID_GRANT)
  assert.equal(result.ok, true)
  assert.equal(result.reason, null)
})

test('enforceOpportunityPolicy: rejects null', () => {
  const result = enforceOpportunityPolicy(null)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'invalid_object')
})

test('enforceOpportunityPolicy: rejects missing URL', () => {
  const result = enforceOpportunityPolicy({ title: 'Grant', description: 'Good content' })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'no_real_url')
})

test('enforceOpportunityPolicy: rejects placeholder URL', () => {
  const result = enforceOpportunityPolicy({ ...VALID_GRANT, url: 'https://example.com/grant' })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'no_real_url')
})

test('enforceOpportunityPolicy: rejects placeholder text', () => {
  const result = enforceOpportunityPolicy({ ...VALID_GRANT, title: 'Lorem ipsum grant' })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'placeholder_text')
})

test('enforceOpportunityPolicy: rejects loan', () => {
  const result = enforceOpportunityPolicy({ ...VALID_GRANT, opportunity_type: 'loan' })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'loan_like')
})

test('enforceOpportunityPolicy: rejects matching-funds', () => {
  const result = enforceOpportunityPolicy({ ...VALID_GRANT, requires_match: true })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'matching_funds')
})

// ─── Rejection counters ───────────────────────────────────────────────────────

test('rejection counters: reset clears counts', () => {
  resetPolicyRejectionCounts()
  const counts = getPolicyRejectionCounts()
  assert.deepEqual(counts, {})
})

test('rejection counters: increment on each rejection type', () => {
  resetPolicyRejectionCounts()

  // Trigger each rejection type
  enforceOpportunityPolicy(null)                            // invalid_object
  enforceOpportunityPolicy({ title: 'Grant', description: 'Real' })   // no_real_url
  enforceOpportunityPolicy({ ...VALID_GRANT, title: 'Lorem ipsum' }) // placeholder_text
  enforceOpportunityPolicy({ ...VALID_GRANT, opportunity_type: 'loan' }) // loan_like
  enforceOpportunityPolicy({ ...VALID_GRANT, requires_match: true })   // matching_funds

  const counts = getPolicyRejectionCounts()
  assert.equal(counts.invalid_object, 1, 'invalid_object should be 1')
  assert.equal(counts.no_real_url, 1, 'no_real_url should be 1')
  assert.equal(counts.placeholder_text, 1, 'placeholder_text should be 1')
  assert.equal(counts.loan_like, 1, 'loan_like should be 1')
  assert.equal(counts.matching_funds, 1, 'matching_funds should be 1')
})

test('rejection counters: valid opp does not increment counters', () => {
  resetPolicyRejectionCounts()
  enforceOpportunityPolicy(VALID_GRANT)
  const counts = getPolicyRejectionCounts()
  assert.deepEqual(counts, {})
})
