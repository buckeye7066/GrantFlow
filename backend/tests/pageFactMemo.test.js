import {buildWebLaneRunRecord} from '../services/coverageAudit/webLaneHealth.js';
import {runWebDiscoveryLane} from '../crawler-os/webLane.js';
import {createMemoryStore} from '../crawler-os/index.js';
import {describe,it,expect,vi} from 'vitest';
import {createPageFactMemo} from '../services/pageFactMemo.js';
import {extractOpportunitiesFromPage} from '../services/webGrantExtractor.js';
const pageUrl='https://example.org/grant';
const html='<main><h1>Example Community Grant</h1><p>Example Foundation offers the Example Community Grant to nonprofit organizations serving Tennessee residents. Applicants must be nonprofit organizations. Awards range from $5,000 to $10,000. No cost share is required.</p></main>';
const response={ok:true,provider:'free:test',json:{opportunities:[{title:'Example Community Grant',funder:'Example Foundation',eligibility_text:'Applicants must be nonprofit organizations.',evidence:{eligibility:'Applicants must be nonprofit organizations.'}}]}};
describe('exact fetched-page fact memo',()=>{
 it('reuses validated facts, not applicant-specific matches, without sharing mutable objects',async()=>{
  const memo=createPageFactMemo();const invoke=vi.fn(async()=>structuredClone(response));
  const first=await extractOpportunitiesFromPage({pageUrl,html},{invoke,openai:null,pageMemo:memo});first[0].title='caller mutation';
  const next=await extractOpportunitiesFromPage({pageUrl,html},{invoke,openai:null,pageMemo:memo});
  expect(invoke).toHaveBeenCalledTimes(1);expect(next[0].title).toBe('Example Community Grant');expect(next.extraction_cached).toBe(true);expect(next.extraction_failure).toBeNull();
 });
 it('changed page bytes or source URL require a fresh extraction',async()=>{
  const memo=createPageFactMemo();const invoke=vi.fn(async()=>structuredClone(response));
  for(const input of [{pageUrl,html},{pageUrl,html:html+' Changed source.'},{pageUrl:pageUrl+'/new',html}])await extractOpportunitiesFromPage(input,{invoke,openai:null,pageMemo:memo});
  expect(invoke).toHaveBeenCalledTimes(3);
 });
 it('does not cache a provider outage or convert cancellation into success',async()=>{
  const memo=createPageFactMemo();const invoke=vi.fn(async()=>({ok:false,openaiError:{status:429}}));
  for(let i=0;i<2;i++)await extractOpportunitiesFromPage({pageUrl,html},{invoke,openai:null,pageMemo:memo});expect(invoke).toHaveBeenCalledTimes(2);
  invoke.mockResolvedValue(response);await extractOpportunitiesFromPage({pageUrl,html},{invoke,openai:null,pageMemo:memo});
  const stopped=await extractOpportunitiesFromPage({pageUrl,html},{invoke,openai:null,pageMemo:memo,signal:AbortSignal.abort()});
  expect(stopped.extraction_status).toBe('failed');expect(stopped.extraction_failure.class).toBe('llm_timeout');
 });
 it('bounds retained data and expires snapshots',()=>{
  let now=0;const memo=createPageFactMemo({now:()=>now,maxEntries:1,ttlMs:1000});
  memo.set('a',[{title:'one'}],'ok');memo.set('b',[{title:'two'}],'ok');expect(memo.get('a')).toBeNull();expect(memo.get('b').data[0].title).toBe('two');now=1001;expect(memo.get('b')).toBeNull();
 });
});

it('counts reusable extraction separately while still fetching the source',async()=>{
 const rows=[];Object.defineProperty(rows,'extraction_cached',{value:true});
 const result=await runWebDiscoveryLane({store:createMemoryStore(),searchWeb:async()=>[{url:pageUrl}],fetcher:{fetch:async()=>({ok:true,body:html,finalUrl:pageUrl})},extractOpportunities:async()=>rows},
 {thesis:{profile_id:'p1',applicant_types:['nonprofit'],needs:['health'],location:{state:'TN'}},maxQueries:1,maxPages:1});
 expect(result.fetched).toBe(1);expect(result.extraction_cache_hits).toBe(1);expect(result.page_ledger[0].extraction_cached).toBe(true);
 const durable=buildWebLaneRunRecord(result,{profileId:'p1',at:'2026-09-19T00:00:00Z'});expect(durable.extraction_cache_hits).toBe(1);expect(durable.pages[0].extraction_cached).toBe(true);
});

it('exposes live provider identity without attributing cached results to a fresh model call',async()=>{
 const memo=createPageFactMemo();const invoke=vi.fn(async()=>structuredClone(response));
 const fresh=await extractOpportunitiesFromPage({pageUrl,html},{invoke,openai:null,pageMemo:memo});
 const cached=await extractOpportunitiesFromPage({pageUrl,html},{invoke,openai:null,pageMemo:memo});
 expect(fresh.extraction_provider).toBe('free:test');
 expect(cached.extraction_provider).toBeNull();
 expect(cached.extraction_cached).toBe(true);
 expect(invoke).toHaveBeenCalledTimes(1);
});
