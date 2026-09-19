import {afterEach,it,expect,vi} from 'vitest'
const calls=vi.hoisted(()=>({crawl:vi.fn(),tests:vi.fn()}))
vi.mock('../services/anyaAutonomousCrawler.js',()=>({runAutonomousCodeCrawl:calls.crawl}))
vi.mock('../services/anyaAutonomousFunctionTesting.js',()=>({runAutonomousFunctionTests:calls.tests}))
vi.mock('../services/auditService.js',()=>({AUDIT_CATEGORIES:{},SEVERITY:{},logAuditEvent:vi.fn(async()=>{})}))
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs()})
it('timed-out editing keeps exclusion until the phase settles and starts no later phase',async()=>{
 vi.stubEnv('ANYA_CODE_CRAWL','true');vi.stubEnv('ANYA_FUNCTION_TESTS','true')
 const {startBackgroundCodeCrawlAndRepair,getBackgroundCodeCrawlState}=await import('../services/anyaAutonomousScheduler.js')
 vi.useFakeTimers();let release
 calls.crawl.mockImplementation(()=>new Promise(resolve=>{release=resolve}))
 try {
  expect(startBackgroundCodeCrawlAndRepair({db:{}}).queued).toBe(true)
  await vi.advanceTimersByTimeAsync(1)
  expect(release).toBeTypeOf('function')
  await vi.advanceTimersByTimeAsync(21600000)
  expect(getBackgroundCodeCrawlState().running).toBe(true)
  expect(startBackgroundCodeCrawlAndRepair({db:{}}).queued).toBe(false)
  release({files_scanned:1,files_modified:0,issues_fixed:0})
  await vi.advanceTimersByTimeAsync(1)
  expect(getBackgroundCodeCrawlState().running).toBe(false)
  expect(getBackgroundCodeCrawlState().lastError).toMatch(/time budget/)
  expect(calls.tests).not.toHaveBeenCalled()
 } finally {release?.({});await vi.advanceTimersByTimeAsync(1)}
})
