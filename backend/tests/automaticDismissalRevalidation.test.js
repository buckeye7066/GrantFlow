import { it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { wrapSqlite } from '../../tests/helpers/sqliteTestDb.mjs'
import { revalidateAutomaticDismissalsAfterCrawl } from '../services/automaticDismissalRevalidation.js'
import { readLockedDismissals, withDismissalProfileTransaction } from '../services/pipelineDismissalPolicy.js'
import { recordDismissal, findDismissal, reconcileDismissedMatches } from '../services/pipelineDismissals.js'

const START = '2026-09-09T05:00:00.000Z'
const FINISH = '2026-09-09T05:03:00.000Z'
const proof = () => ({ direct_funding: true, all_passed: true,
  real: { passed: true, reality_status: 'VERIFIED', evidence_url: 'https://www.ssa.gov/disability', content_hash_present: true, evidence_captured_at: '2026-09-09T05:01:00.000Z' },
  relatable: { passed: true, canonical_decision: 'ACCEPT' },
  meets_profile_need: { passed: true, profile_needs_defaulted: false, matched_needs: ['disability'] },
  profile_qualifies: { passed: true, eligibility: true },
})
function fixture({ actor = 'system_pipeline_precision', reason = 'pipeline_precision:covers_need:profile_mismatch' } = {}) {
  const raw = new Database(':memory:')
  raw.exec(`
    CREATE TABLE profiles (id TEXT PRIMARY KEY, status TEXT, deleted_at TEXT, display_name TEXT);
    CREATE TABLE profile_sections (profile_id TEXT, section_key TEXT, data TEXT);
    CREATE TABLE funding_opportunities (id TEXT PRIMARY KEY, title TEXT, sponsor TEXT, description TEXT, source_url TEXT, application_url TEXT, opportunity_kind TEXT, is_active INTEGER, is_hidden INTEGER, status TEXT);
    CREATE TABLE profile_opportunity_matches (id TEXT PRIMARY KEY, profile_id TEXT, opportunity_id TEXT, matcher_version TEXT, match_decision TEXT, computed_at TEXT, evaluated_at TEXT, match_explain_json TEXT);
    CREATE TABLE pipeline_dismissals (id TEXT PRIMARY KEY, profile_id TEXT, fingerprint TEXT, opportunity_id TEXT, source_url TEXT, title TEXT, reason TEXT, dismissed_by TEXT, dismissed_at TEXT);
    CREATE TABLE pipeline_promotion_outcomes (profile_id TEXT, opportunity_id TEXT, mode TEXT, outcome TEXT, reason TEXT, PRIMARY KEY(profile_id,opportunity_id));
    CREATE TABLE audit_events (id TEXT PRIMARY KEY, created_at TEXT DEFAULT CURRENT_TIMESTAMP, actor_type TEXT, actor_id TEXT, entity_type TEXT, entity_id TEXT, action TEXT, before_json TEXT, after_json TEXT);
    INSERT INTO profiles VALUES ('p1','active',NULL,'Person');
    INSERT INTO funding_opportunities VALUES ('ssa','Social Security Disability','SSA','Disability assistance','https://www.ssa.gov/disability','https://www.ssa.gov/disability','benefit',1,0,'active');
    INSERT INTO pipeline_promotion_outcomes VALUES ('p1','ssa','live','tombstoned','old automated failure');
  `)
  raw.prepare('INSERT INTO pipeline_dismissals VALUES (?,?,?,?,?,?,?,?,?)').run('d1','p1',null,'ssa','https://www.ssa.gov/disability','Social Security Disability',reason,actor,'2026-09-02T00:00:00.000Z')
  raw.prepare('INSERT INTO profile_opportunity_matches VALUES (?,?,?,?,?,?,?,?)').run('m1','p1','ssa','crawler-os','accept',FINISH,FINISH,JSON.stringify({canonical_decision:'ACCEPT',four_truth_proof:proof()}))
  const db = wrapSqlite(raw)
  let pending = Promise.resolve()
  db.withTransaction = async callback => {
    const prior = pending
    let release
    pending = new Promise(resolve => { release = resolve })
    await prior
    raw.exec('BEGIN IMMEDIATE')
    try { const result = await callback(db); raw.exec('COMMIT'); return result }
    catch (error) { raw.exec('ROLLBACK'); throw error }
    finally { release() }
  }
  const run = { run_id:'run-fresh',profile_id:'p1',started_at:START,finished_at:FINISH,recommendations:[{opportunity_id:'ssa',decision:'accept',four_truth_proof:proof()}] }
  const evaluateCurrent = async () => ({ pass: true, gates: { real: true, qualifies: true, covers_need: true, relatable: true, engine: true } })
  const apply = (options = {}) => revalidateAutomaticDismissalsAfterCrawl(db, { profileId:'p1',run,evaluateCurrent,...options })
  return { raw,db,run,apply }
}

for (const [actor,reason] of [
  ['system_pipeline_precision','pipeline_precision:covers_need:profile_mismatch'],
  ['system_crawler_os','crawler_os_reject'],
  ['migration:999_strict_pipeline_task_reconciliation','strict_pipeline:real:real:link_not_positively_verified:unknown'],
  ['migration:1000_fail_closed_hamilton_reconciliation','strict_pipeline:qualifies:profile_mismatch'],
]) it(`fresh proof revokes ${actor} exact pair, archives it, and survives sticky cleanup/promotion lookup`, async () => {
  const f=fixture({actor,reason})
  try {
    const before=f.raw.prepare('SELECT * FROM pipeline_dismissals').get()
    expect((await f.apply()).revalidated).toBe(1)
    const archive=f.raw.prepare('SELECT * FROM audit_events').get()
    expect(JSON.parse(archive.before_json)).toEqual(before)
    expect(JSON.parse(archive.after_json).run_id).toBe('run-fresh')
    expect(await findDismissal(f.db,'p1',{id:'ssa',title:'Social Security Disability'})).toBeNull()
    expect(await reconcileDismissedMatches(f.db)).toBe(0)
    expect(f.raw.prepare('SELECT COUNT(*) AS n FROM profile_opportunity_matches').get().n).toBe(1)
    expect(f.raw.prepare('SELECT COUNT(*) AS n FROM pipeline_promotion_outcomes').get().n).toBe(0)
    expect((await f.apply()).revalidated).toBe(0)
  } finally {f.raw.close()}
})

it.each([
  ['user-1','owner_removed_from_funding_sources'],
  ['system_admin_token','user_deleted_from_pipeline'],
  ['unknown','pipeline_precision:covers_need:profile_mismatch'],
  ['agent:robert','robert_pipeline_audit:qualifies:profile_mismatch'],
  ['system_pipeline_precision','pipeline_precision:qualifies:duplicate'],
])('protects manual, unknown and duplicate provenance %s',async(actor,reason)=>{
  const f=fixture({actor,reason});try{expect((await f.apply()).revalidated).toBe(0);expect(f.raw.prepare('SELECT COUNT(*) AS n FROM pipeline_dismissals').get().n).toBe(1)}finally{f.raw.close()}
})

it.each(['review','incomplete','old-proof','old-run','wrong-profile','wrong-id','current-rejection'])('refuses %s evidence',async variant=>{
  const f=fixture();try{
    const options={}
    if(variant==='review')f.raw.prepare("UPDATE profile_opportunity_matches SET match_decision='review'").run()
    if(variant==='incomplete'){f.run.recommendations[0].four_truth_proof.real.content_hash_present=false}
    if(variant==='old-proof'){f.run.recommendations[0].four_truth_proof.real.evidence_captured_at='2026-08-01T00:00:00.000Z'}
    if(variant==='old-run')f.run.started_at='2026-08-01T00:00:00.000Z'
    if(variant==='wrong-profile')f.run.profile_id='p2'
    if(variant==='wrong-id')f.run.recommendations[0].opportunity_id='other'
    if(variant==='current-rejection')options.evaluateCurrent=async()=>({pass:false,gates:{qualifies:false}})
    expect((await f.apply(options)).revalidated).toBe(0)
    expect(f.raw.prepare('SELECT COUNT(*) AS n FROM pipeline_dismissals').get().n).toBe(1)
  }finally{f.raw.close()}
})

it('user intent supersedes an existing automatic dismissal and prevents revival',async()=>{
 const f=fixture();try{
  await recordDismissal(f.db,{profileId:'p1',opportunity:{id:'ssa',title:'Social Security Disability'},userId:'user-1',reason:'owner_removed_from_funding_sources'})
  expect(f.raw.prepare('SELECT dismissed_by FROM pipeline_dismissals').get().dismissed_by).toBe('user-1')
  expect((await f.apply()).revalidated).toBe(0)
 }finally{f.raw.close()}
})

it('a later user dismissal wins when racing a successful revalidation',async()=>{
 const f=fixture();try{
  let entered, resume
  const enteredPromise=new Promise(r=>{entered=r})
  const resumePromise=new Promise(r=>{resume=r})
  const repairing=f.apply({evaluateCurrent:async()=>{entered();await resumePromise;return{pass:true}}})
  await enteredPromise
  const dismissing=recordDismissal(f.db,{profileId:'p1',opportunity:{id:'ssa',title:'Social Security Disability'},userId:'user-1',reason:'owner_removed_from_funding_sources'})
  resume();await repairing;await dismissing
  expect(f.raw.prepare('SELECT dismissed_by FROM pipeline_dismissals').get().dismissed_by).toBe('user-1')
 }finally{f.raw.close()}
})

it('archive failure rolls back removal and promotion-state changes',async()=>{
 const f=fixture();try{
  f.raw.exec("CREATE TRIGGER fail_archive BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'archive unavailable'); END")
  await expect(f.apply()).rejects.toThrow('archive unavailable')
  expect(f.raw.prepare('SELECT COUNT(*) AS n FROM pipeline_dismissals').get().n).toBe(1)
  expect(f.raw.prepare('SELECT COUNT(*) AS n FROM pipeline_promotion_outcomes').get().n).toBe(1)
 }finally{f.raw.close()}
})

it.each(['candidate-profile', 'different-proof', 'future-persistence'])('refuses mismatched current run %s', async variant => {
 const f = fixture(); try {
  if (variant === 'candidate-profile') f.run.recommendations[0].profile_id = 'p2'
  if (variant === 'different-proof') f.run.recommendations[0].four_truth_proof.real.evidence_url = 'https://www.ssa.gov/other'
  if (variant === 'future-persistence') f.raw.prepare('UPDATE profile_opportunity_matches SET computed_at = ?').run('2099-01-01T00:00:00Z')
  expect((await f.apply()).revalidated).toBe(0)
 } finally { f.raw.close() }
})
it.each([true, false])('honors only exact-pair user deletion audit (same pair=%s)', async samePair => {
 const f=fixture(); try {
  f.raw.prepare("INSERT INTO audit_events (id,actor_type,entity_type,entity_id,action,before_json) VALUES ('user-event','user','funding_opportunity','ssa','deleted',?)").run(JSON.stringify({profile_id:samePair?'p1':'p2',opportunity_id:'ssa'}))
  const original=f.db.prepare.bind(f.db)
  f.db.prepare=sql=>{if(sql.includes("actor_type = 'user'")){expect(sql).toContain('CAST(before_json AS TEXT) LIKE');expect(sql).toContain('CAST(after_json AS TEXT) LIKE')}return original(sql)}
  expect((await f.apply()).revalidated).toBe(samePair?0:1)
 } finally {f.raw.close()}
})
it('preserves legacy unattributed crawler rejections',async()=>{
 const f=fixture({actor:null,reason:'crawler_os_reject'});try{expect((await f.apply()).revalidated).toBe(0)}finally{f.raw.close()}
})

it('reads PostgreSQL tombstones as full JSONB so microsecond timestamps survive archive and CAS', async () => {
 const original={id:'d1',profile_id:'p1',dismissed_at:'2026-09-02T00:00:00.044123+00:00',reason:'pipeline_precision:real:unknown',dismissed_by:'system_pipeline_precision'}
 const tx={dialect:'postgres',prepare(sql){expect(sql).toContain('to_jsonb(d) AS original_row');expect(sql).toContain('FOR UPDATE');return{all:async(...args)=>{expect(args).toEqual(['p1']);return[{original_row:original}]}}}}
 expect(await readLockedDismissals(tx,'p1')).toEqual([original])
})
it('reuses an explicit PostgreSQL transaction and takes the same profile advisory lock',async()=>{
 const calls=[]
 const tx={dialect:'postgres',prepare(sql){return{get:async(...args)=>{calls.push({sql,args})}}}}
 const result=await withDismissalProfileTransaction(tx,'p1',async received=>{expect(received).toBe(tx);return 42})
 expect(result).toBe(42);expect(calls[0].args).toEqual(['pipeline-dismissal-profile','p1']);expect(calls[0].sql).toContain('pg_advisory_xact_lock')
})
it('a protected same-title alias blocks exact automatic revocation',async()=>{
 const f=fixture();try{
  f.raw.prepare("INSERT INTO pipeline_dismissals VALUES ('manual','p1',NULL,'alias',NULL,'Social Security Disability','owner_removed_from_funding_sources','owner','2026-09-01')").run()
  expect((await f.apply()).revalidated).toBe(0)
 }finally{f.raw.close()}
})
it('a failed compare-and-delete rolls back its already-written archive',async()=>{
 const f=fixture();try{
  f.raw.exec("CREATE TRIGGER ignore_delete BEFORE DELETE ON pipeline_dismissals BEGIN SELECT RAISE(IGNORE); END")
  await expect(f.apply()).rejects.toThrow('Dismissal changed')
  expect(f.raw.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n).toBe(0)
  expect(f.raw.prepare('SELECT COUNT(*) AS n FROM pipeline_dismissals').get().n).toBe(1)
 }finally{f.raw.close()}
})

it('retains microsecond timestamp precision through the archive and exact delete predicate',async()=>{
 const f=fixture();try{
  const exact='2026-09-02T00:51:54.044526+00:00'
  f.raw.prepare('UPDATE pipeline_dismissals SET dismissed_at = ?').run(exact)
  expect((await f.apply()).revalidated).toBe(1)
  expect(JSON.parse(f.raw.prepare('SELECT before_json FROM audit_events').get().before_json).dismissed_at).toBe(exact)
 }finally{f.raw.close()}
})
