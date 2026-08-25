import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const APPLICANT_WORKFLOW_SURFACES = [
  'src/api/hamilton.js',
  'src/components/billing/SettingsTab.jsx',
  'src/components/hamilton/TailoredApplicationPanel.jsx',
  'src/components/pipeline/PipelineAutomationPanel.jsx',
  'src/config/helpRegistry.js',
  'src/pages/EndUserPipeline.jsx',
  'src/pages/FundingLibrary.jsx',
]

const authorizationNoun = 'appro' + 'val'
const authorizationVerb = 'appro' + 've'
const flexibleSeparator = '[- _\\n]*'
const FORBIDDEN_MANUAL_CHECKPOINT_COPY = [
  new RegExp('sign' + flexibleSeparator + 'off', 'i'),
  new RegExp('await' + 'ing\\s+' + authorizationNoun, 'i'),
  new RegExp(authorizationNoun + '\\s+before\\s+send' + 'ing', 'i'),
  new RegExp('owner\\s+' + authorizationNoun, 'i'),
  new RegExp(authorizationVerb + '\\s+this\\s+application', 'i'),
  new RegExp('save\\s*&\\s*' + authorizationVerb, 'i'),
  new RegExp('draft\\s+' + authorizationVerb + 'd', 'i'),
  new RegExp(authorizationVerb + 'd\\s+draft', 'i'),
  new RegExp('editing\\s+counts\\s+as\\s+your\\s+' + authorizationNoun, 'i'),
  new RegExp('only\\s+add[^\\n.]*with\\s+your\\s+' + authorizationNoun, 'i'),
]

test('applicant workflows do not introduce a second manual authorization checkpoint', () => {
  for (const relativePath of APPLICANT_WORKFLOW_SURFACES) {
    const source = fs.readFileSync(path.join(root, relativePath), 'utf8')
    for (const pattern of FORBIDDEN_MANUAL_CHECKPOINT_COPY) {
      assert.doesNotMatch(source, pattern, `${relativePath} contains retired checkpoint copy: ${pattern}`)
    }
  }
})

test('Hamilton tells applicants the actual auto-submit and missing-information contract', () => {
  const panel = fs.readFileSync(
    path.join(root, 'src/components/hamilton/TailoredApplicationPanel.jsx'),
    'utf8',
  )

  assert.match(panel, /backend's complete submission decision/)
  assert.match(panel, /Hamilton can use this draft and submit/)
  assert.match(panel, /required questions above before Hamilton can submit/)
  assert.match(panel, /portal_url_not_browser_executable/)
  assert.match(panel, /global_auto_submit_disabled/)
})

test('draft edits remain editable without manufacturing authorization metadata', () => {
  const route = fs.readFileSync(
    path.join(root, 'backend/routes/hamiltonTailoredApplication.js'),
    'utf8',
  )
  const store = fs.readFileSync(
    path.join(root, 'backend/services/hamilton/tailoredApplicationStore.js'),
    'utf8',
  )
  const editRoute = route.slice(route.indexOf("router.post('/edit'"), route.indexOf("router.post('/regenerate'"))

  assert.doesNotMatch(editRoute, /isApprovalBlocked/)
  assert.doesNotMatch(editRoute, /approvedBy/)
  assert.match(editRoute, /Applicant edited Hamilton/)
  assert.match(store, /status = 'edited',[\s\S]*approved_by = NULL, approved_at = NULL/)
})

test('billing and Robert surfaces do not promise nonexistent automation or hidden pipeline mutation', () => {
  const billing = fs.readFileSync(path.join(root, 'src/components/billing/SettingsTab.jsx'), 'utf8')
  const library = fs.readFileSync(path.join(root, 'src/pages/FundingLibrary.jsx'), 'utf8')

  assert.doesNotMatch(billing, /Send Invoice Emails Automatically/i)
  assert.doesNotMatch(billing, /auto_email_requires_approval/)
  assert.match(library, /select Add to Pipeline/)
})

test('tailored-card readiness composes every irreversible-submit veto', () => {
  const decision = fs.readFileSync(
    path.join(root, 'backend/services/hamilton/tailoredSubmissionDecision.js'),
    'utf8',
  )
  const route = fs.readFileSync(
    path.join(root, 'backend/routes/hamiltonTailoredApplication.js'),
    'utf8',
  )

  for (const contract of [
    'resolveSubmissionDecision',
    'isAutoSubmitGloballyEnabled',
    'isFullAutomationEnabled',
    'reviewedPortalSubmissionExecutionAvailable',
    'isAutomationEnabled',
    'evaluateAutoSubmitGate',
  ]) assert.match(decision, new RegExp(contract))
  assert.match(route, /resolveTailoredSubmissionDecision/)
  assert.match(route, /submission_decision/)
})
