import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { persistedScoringPolicyReceipt } from '../routes/fundingSources.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const routePath = path.resolve(__dirname, '../routes/fundingSources.js')

describe('GET funding-sources is SELECT-only presentation', () => {
  it('does not run schema setup or reconcile/write scores while reading', () => {
    const source = fs.readFileSync(routePath, 'utf8')
    expect(source).not.toContain('ensurePipelineDismissalsSchema')
    expect(source).not.toContain('reconcileNeedFirstProfileMatches')
    expect(source).not.toContain('restorePersistedMatchTruth')
    expect(source).not.toContain('applyNeedFirstScoring')
    expect(source).toContain('deferred_to_background: true')
    expect(source).toContain('read_only: true')
  })

  it('reports persisted scoring-policy truth instead of stamping every row current', () => {
    expect(persistedScoringPolicyReceipt([
      { scoring_policy_version: 'need_first_v2' },
      { scoring_policy_version: 'need_first_v2' },
    ])).toMatchObject({
      version: 'need_first_v2',
      versions: { need_first_v2: 2 },
      unknown: 0,
      all_current: true,
    })

    expect(persistedScoringPolicyReceipt([
      { scoring_policy_version: 'need_first_v1' },
      { scoring_policy_version: 'need_first_v2' },
      { scoring_policy_version: null },
    ])).toMatchObject({
      version: null,
      versions: { need_first_v1: 1, need_first_v2: 1 },
      unknown: 1,
      all_current: false,
    })
  })
})
