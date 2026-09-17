import { describe,it,expect } from 'vitest'
import { liveOppToOs } from '../services/coverageAudit/surfacedEligibility.js'
import { calculateSourceTrust } from '../services/matchEngine.js'
import { evaluateFundableOpportunity } from '../services/matching/qualityGate.js'
import { assessReality } from '../services/opportunityRealityGate.js'
import { buildOpportunityReadModel } from '../services/opportunityContract.js'
import { structuralApplyable } from '../services/robert/robertSourceAcquisition.js'
import { verifyOpportunity } from '../services/robert/robertVerification.js'

const selected='https://www.tn.gov/collegepays/apply'
const base={id:'target-parity',title:'Tennessee Education Scholarship',sponsor:'Tennessee Foundation',
  description:'Scholarships for Tennessee college students.',source:'grants_gov',record_origin:'grants_gov',
  opportunity_kind:'direct_grant',application_url:selected,source_url:'https://www.tn.gov/collegepays',
  state:'TN',entity_types_allowed:['student'],need_types_supported:['education'],categories:['education'],
  amount_max:1000,deadline_type:'rolling',is_active:true}
const conflict={...base,apply_url:selected,application_url:'https://www.facebook.com/foundation'}
describe('shared selected-target parity across remaining backend consumers',()=>{
  it('the post-crawl eligibility adapter does not invert target aliases',()=>{
    expect(liveOppToOs(conflict).apply_url).toBe(selected)
  })
  it('source trust uses the same target with or without a stale alternate',()=>{
    expect(calculateSourceTrust({...conflict,record_origin:null})).toBe(calculateSourceTrust({...base,record_origin:null}))
  })
  it('the quality gate does not evaluate an alternate blog instead of the application',()=>{
    const row={...conflict,application_url:'https://foundation.org/blog/news'}
    expect(evaluateFundableOpportunity(base).ok).toBe(true)
    expect(evaluateFundableOpportunity(row).ok).toBe(true)
  })
  it('the reality gate ignores a stale secondary social URL but refuses the selected social target',()=>{
    expect(assessReality(base).allowed).toBe(true)
    expect(assessReality(conflict).allowed).toBe(true)
    expect(assessReality({...base,apply_url:'https://www.facebook.com/foundation'}).allowed).toBe(false)
  })
  it('the opportunity read model preserves an explicit authoritative override and shared fallback order',()=>{
    expect(buildOpportunityReadModel(conflict).authoritative_application_url).toBe(selected)
    expect(buildOpportunityReadModel({...conflict,authoritative_application_url:'https://foundation.org/verified'}).authoritative_application_url)
      .toBe('https://foundation.org/verified')
  })
  it('structural acquisition uses the selected application path, not an alternate homepage',()=>{
    expect(structuralApplyable(base)).toBe(true)
    expect(structuralApplyable({...base,apply_url:selected,application_url:'https://foundation.org/'})).toBe(true)
  })
  it('Robert verifies the selected URL rather than rejecting an alternate search URL',async()=>{
    const calls=[]
    const options={config:{allowLiveWeb:true,requireRealApplicationUrl:true},checkUrl:async url=>{calls.push(url);return {status:'ok',code:200}}}
    const control=await verifyOpportunity({...options,opportunity:base})
    expect(control.ok,JSON.stringify(control)).toBe(true)
    calls.length=0
    const result=await verifyOpportunity({...options,opportunity:{...base,apply_url:selected,application_url:'https://google.com/search?q=scholarship'}})
    expect(result.ok,JSON.stringify(result)).toBe(true)
    expect(calls).toEqual([selected])
  })
})

it.each(['https://www.facebook.com/apply','https://alpha.grantable.co/apply'])('a usable alternate never authorizes a refused structural application: %s',target=>{
  expect(structuralApplyable({...base,apply_url:target})).toBe(false)
})
it('Robert never verifies a selected vendor login as a funder application',async()=>{
  const result=await verifyOpportunity({opportunity:{...base,apply_url:'https://alpha.grantable.co/apply'}})
  expect(result.ok).toBe(false)
})
