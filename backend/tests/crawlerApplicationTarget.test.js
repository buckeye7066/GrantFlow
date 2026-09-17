import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { loadCrawlerOsProfileResults } from '../services/crawlerOsCompatibility.js'
import { mapResultToFrontendShape } from '../routes/realCrawlers.js'
import { verifiedFourTruthExplain } from './helpers/fourTruthFixture.js'

const selected = 'https://www.tn.gov/collegepays/apply'
const stale = 'https://alpha.grantable.co/login'
const info = 'https://www.tn.gov/collegepays'

describe('live crawler result application target', () => {
  it('carries the actual preferred SQL alias through the compatibility bridge and final mapper', async () => {
    const db = new Database(':memory:')
    try {
      db.exec(`CREATE TABLE funding_opportunities (id,title,sponsor,description,application_url,apply_url,
        source_url,opportunity_kind,deadline,amount_min,amount_max,state,categories,funding_type,is_hidden,is_active);
        CREATE TABLE profile_opportunity_matches (profile_id,opportunity_id,match_score,match_decision,
        match_explanation,match_reasons,match_explain_json,matcher_version);`)
      db.prepare('INSERT INTO funding_opportunities VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run('target-fixture','Student assistance','TN Foundation','Student education grant',stale,selected,
          info,'direct_grant',null,100,1000,'TN','["education"]','grant',0,1)
      db.prepare('INSERT INTO profile_opportunity_matches VALUES (?,?,?,?,?,?,?,?)')
        .run('p','target-fixture',50,'ACCEPT','Verified fixture','[]',verifiedFourTruthExplain(),'crawler-os')
      const rows = await loadCrawlerOsProfileResults(db,'p')
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ applicationUrl: selected, url: selected, sourceUrl: info })
      expect(mapResultToFrontendShape(rows[0])).toMatchObject({ application_url: selected, url: selected, source_url: info })
    } finally { db.close() }
  })
  it('normalizes mixed snake/camel aliases before a response can discard them', () => {
    expect(mapResultToFrontendShape({ id:'row',name:'Test',apply_url:selected,applicationUrl:stale,url:info,sourceUrl:info }))
      .toMatchObject({ application_url:selected,url:selected,source_url:info })
  })
  it('keeps the existing generic URL-only compatibility contract', () => {
    expect(mapResultToFrontendShape({ id:'row',name:'Test',url:selected }))
      .toMatchObject({ application_url:selected,url:selected,source_url:selected })
  })
})
