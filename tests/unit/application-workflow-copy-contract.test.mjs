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

const FORBIDDEN_MANUAL_CHECKPOINT_COPY = [
  /sign[- ]off/i,
  /awaiting approval/i,
  /approval before sending/i,
  /owner approval/i,
  /approve this application/i,
  /save\s*&\s*approve/i,
  /draft approved/i,
  /approved draft/i,
  /editing counts as your approval/i,
  /only add[^\n.]*with your approval/i,
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

  assert.match(panel, /Enabling auto-submit is the submission authorization/)
  assert.match(panel, /Hamilton can use this draft and submit/)
  assert.match(panel, /required questions above before Hamilton can submit/)
})
