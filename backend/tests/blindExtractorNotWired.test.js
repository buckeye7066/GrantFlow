/**
 * STATIC TRIPWIRE — the profile-blind extractor is now the LIVE web authority.
 *
 * Search remains profile-keyed, but only webGrantExtractor may turn fetched page
 * bytes into live candidates. The live mapper must not copy `thesis` facts into
 * the candidate, and no second production extractor may bypass the evidence
 * validator/link inventory.
 */

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..')

const extractor = () => fs.readFileSync(
  path.join(REPO_ROOT, 'backend/services/webGrantExtractor.js'),
  'utf8',
)
const lane = () => fs.readFileSync(
  path.join(REPO_ROOT, 'backend/crawler-os/webLane.js'),
  'utf8',
)

describe('profile-blind extraction is the live web authority', () => {
  it('the live extractor imports the evidence, inventory, and profile-blind mapper chain', () => {
    const text = extractor()
    for (const moduleName of [
      'blindLinkInventory',
      'blindPageFactExtractor',
      'blindFactsMapper',
      'blindOpportunityKind',
    ]) {
      expect(text, `live extractor must use ${moduleName}`).toContain(moduleName)
    }
    expect(text).not.toContain('describeThesis')
    expect(text).not.toContain('APPLICANT PROFILE')
    expect(text).not.toContain('relevant: boolean')
  })

  it('the live lane never stamps the searching profile onto opportunity facts', () => {
    const text = lane()
    expect(text).not.toContain('profState')
    expect(text).not.toContain('deriveNeeds(ex, thesis.needs)')
    expect(text).not.toContain('applicant_types: Array.isArray(thesis.applicant_types)')
    expect(text).toContain('applicant_types: []')
    expect(text).toContain('need_categories: cleanStringArray(ex.need_categories')
    expect(text).toContain('geography: { national, states }')
  })

  it('the live lane does not pass thesis/query into extraction', () => {
    const text = lane()
    expect(text).toContain('extractOpportunities({ pageUrl: evidence.url, html: resp.body })')
    expect(text).not.toContain('html: resp.body, thesis, query: page.query')
  })
})
