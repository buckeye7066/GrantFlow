import {describe,it,expect} from 'vitest'
import {profileContextToThesisInput} from '../services/crawlerOsPersistenceCore.js'
import {buildThesis} from '../crawler-os/profileIntelligence.js'
import {buildWebQueryPlan} from '../crawler-os/webQueries.js'
import {normalizeProfile} from '../services/profileNormalizer.js'
import {declaredNeedsFrom} from '../services/pipelinePrecision.js'

const cases = [
 ['nonprofit','15 passenger bus'],['individual','power wheelchair'],
 ['senior','home repairs'],['volunteer_fire_department','SCBA equipment'],
 ['church','commercial refrigerator'],['school','Braille embosser'],
 ['small_business','industrial freeze dryer'],['farmer','soil conservation'],
 ['graduate_student','research fellowship'],
]

it('keeps declared request fields consistent between discovery, matching and pipeline admission',()=>{
 const profile={primary_type:'individual',primary_needs:['transportation']}
 const sections={custom_requests:{item_needs:['housing'],assistance_needs:'utilities',funding_needs:'over $15000'}}
 const expected=['housing','transportation','utilities']
 expect(normalizeProfile(profile,sections).needCategories.sort()).toEqual(expected)
 expect(declaredNeedsFrom(profile,sections).sort()).toEqual(expected)
 const thesis=buildThesis(profileContextToThesisInput({profile,sections}))
 expect(thesis.needs).toEqual(expect.arrayContaining(expected))
 expect(thesis.needs_defaulted).toBe(false)
})
function thesisFor(type,request,field='item_needs') {
 return buildThesis(profileContextToThesisInput({
  profile:{id:'synthetic-query',primary_type:type},
  sections:{basic_information:{state:'OH',city:'Dayton',county:'Montgomery'},financial_information:{[field]:[request]}},
  signals:{location:{state:'OH',city:'Dayton',county:'Montgomery'},needs_structured:new Set()},
 }))
}
describe('the live profile bridge preserves the actual requested need in search',()=>{
 it.each(cases)('%s searches for %s in the early execution window',(type,request)=>{
  const thesis=thesisFor(type,request)
  expect(thesis.declared_need_terms).toContain(request.toLowerCase())
  const plan=buildWebQueryPlan(thesis,{max:12,seed:0,year:2026})
  expect(plan.queries.slice(0,6).some(q=>q.includes(request.toLowerCase()))).toBe(true)
  expect(plan.queries[0]).toContain(request.toLowerCase())
 })
 it('also retains assistance-needs wording that has no exact taxonomy id',()=>{
  expect(buildWebQueryPlan(thesisFor('individual','home repairs','assistance_needs'),{max:6}).queries[0]).toContain('home repairs')
 })
 it('does not copy narrative, contact data, negations or type defaults into declared search requests',()=>{
  const t=buildThesis(profileContextToThesisInput({profile:{primary_type:'nonprofit'},sections:{
   narrative:{primary_goal:'private contact private@example.invalid needs a bus'},
   financial_information:{funding_needs:'over $15000',item_needs:['unknown','no wheelchair needed','Call 937-555-0100 for a bus','Email private@example.invalid','https://private.example.invalid']},
  }}))
  expect(t.declared_need_terms).toEqual([])
 })
 it('retains an uncommon request supplied directly to the OS',()=>{
  const t=buildThesis({primary_type:'nonprofit',needs:['portable planetarium'],state:'OH'})
  expect(buildWebQueryPlan(t,{max:6}).queries[0]).toContain('portable planetarium')
 })
})


it('rotates other declared needs into the early window without losing the first priority',()=>{
 const requests=['portable planetarium','Braille embosser','commercial refrigerator','accessible passenger van','industrial freeze dryer']
 const t=buildThesis({primary_type:'nonprofit',needs:requests,state:'OH'})
 const seen=new Set()
 for(let seed=0;seed<requests.length;seed++) {
  const q=buildWebQueryPlan(t,{max:6,seed}).queries
  expect(q[0]).toContain(requests[0])
  for(const request of requests)if(q.some(text=>text.includes(request.toLowerCase())))seen.add(request)
 }
 expect([...seen].sort()).toEqual([...requests].sort())
})
