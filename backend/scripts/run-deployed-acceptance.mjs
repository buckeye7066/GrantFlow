import {execFile as execFileCallback, spawn} from 'node:child_process'
import {promisify} from 'node:util'
import {mkdtemp, mkdir, symlink, readFile, writeFile, appendFile, rm, open} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {randomUUID} from 'node:crypto'

const execFile = promisify(execFileCallback)
export function assertAcceptanceNotInterrupted(interrupted) {
  if(interrupted) throw new Error('acceptance_interrupted')
}

export function validateRevision(value) {
  if (!/^[a-f0-9]{40}$/.test(value || '')) throw new Error('exact_revision_required')
  return value
}
export function buildAcceptanceEnvironment(env = process.env) {
  const clean = {}
  for (const name of ['PATH','SEARXNG_URL','SIMPLER_GRANTS_API_KEY','SAM_GOV_API_KEY','SAM_GOV_PUBLIC_API_KEY']) {
    if (env[name]) clean[name] = env[name]
  }
  return {...clean, HOME: '/tmp', NODE_ENV: 'acceptance', LOG_LEVEL: 'warn',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    FREE_AI_ROUTES: JSON.stringify([{id:'cloud-local',base_url:'http://127.0.0.1:11434/v1',
      model:'llama3.2:1b',json_mode:true,json_schema_mode:true}]),
    FREE_AI_TIMEOUT_MS:'60000',
    OWNER_AI_BRIDGE_ENABLED:'false', AI_PAID_ROUTES:'[]', WEB_SEARCH_CACHE_TTL_HOURS:'0', GRANTFLOW_PAGE_FACT_MEMO_ENABLED:'1',
  }
}

/** Run the unchanged, exact-fifty acceptance command in a disposable checkout.
 * No production DB, account, mail, paid-model or GitHub credentials are inherited.
 * Public Git source is verified at the requested immutable commit before execution.
 */
export async function runDeployedAcceptance(sha) {
  validateRevision(sha)
  const folder = await mkdtemp(path.join(tmpdir(), 'grantflow-release-acceptance-'))
  const reportDir = '/data/acceptance-results'
  await mkdir(reportDir, {recursive:true,mode:0o700})
  const runId = new Date().toISOString().replace(/[^0-9]/g,'') + '-' + randomUUID().slice(0,8)
  const reportPath = path.join(reportDir,runId+'.json')
  const log = await open(path.join(reportDir,runId+'.log'),'wx',0o600)
  const env = buildAcceptanceEnvironment()
  let child = null
  let interrupted = false
  let timer = null
  let forceStopTimer = null
  let loggedBytes = 0
  const stop = () => {
    interrupted=true
    child?.kill('SIGTERM')
    if (child && !forceStopTimer) {
      forceStopTimer=setTimeout(()=>child?.kill('SIGKILL'),15000)
      forceStopTimer.unref()
    }
  }
  process.once('SIGTERM',stop)
  process.once('SIGINT',stop)
  const git = async args => (await execFile('git',args,{cwd:folder,env,timeout:120000,maxBuffer:4*1024*1024})).stdout.trim()
  try {
    console.log(JSON.stringify({event:'acceptance_start',sha,runId,reportPath,production_data:false}))
    await git(['init','--quiet'])
    await git(['remote','add','origin','https://github.com/buckeye7066/GrantFlow.git'])
    await git(['fetch','--quiet','--depth=1','origin',sha])
    await git(['checkout','--quiet','--detach','FETCH_HEAD'])
    if (await git(['rev-parse','HEAD']) !== sha) throw new Error('source_revision_mismatch')
    const deployedLock = await readFile('/app/package-lock.json','utf8')
    if (await readFile(path.join(folder,'package-lock.json'),'utf8') !== deployedLock) throw new Error('runtime_dependency_lock_mismatch')
    // Child temp files, including its independently-created SQLite database,
    // stay under this disposable root even if the child is interrupted.
    env.TMPDIR=path.join(folder,'tmp')
    env.TEMP=env.TMPDIR
    env.TMP=env.TMPDIR
    await mkdir(env.TMPDIR,{recursive:true,mode:0o700})
    await symlink('/app/node_modules',path.join(folder,'node_modules'),'dir')
    // A Git directory-only ignore does not match a Linux symlink. Ignore only
    // this verified runtime dependency binding, not any application source.
    await appendFile(path.join(folder,'.git','info','exclude'),'/node_modules\n','utf8')
    if (await git(['status','--porcelain'])) throw new Error('acceptance_source_not_clean')
    if (interrupted) throw new Error('acceptance_interrupted')
    const relativeReceipt='audit-reports/deployed-exact50.json'
    const exitCode=await new Promise((resolve,reject)=>{
      child=spawn(process.execPath,['scripts/grantflow-acceptance-50.mjs','--expected-sha='+sha,'--output='+relativeReceipt,
        '--allowed-providers=searxng'],{cwd:folder,env,stdio:['ignore','pipe','pipe'],shell:false})
      const capture=chunk=>{
        const part=chunk.subarray(0,Math.max(0,32*1024*1024-loggedBytes))
        loggedBytes+=part.length
        if(part.length)log.write(part).catch(()=>{})
      }
      child.stdout.on('data',capture)
      child.stderr.on('data',capture)
      child.once('error',reject)
      child.once('exit',code=>resolve(code??1))
      // Bound an unattended acceptance run, not its pass criteria or cohort size.
      timer=setTimeout(stop,2*60*60*1000)
    })
    clearTimeout(timer)
    assertAcceptanceNotInterrupted(interrupted)
    const raw=await readFile(path.join(folder,relativeReceipt),'utf8')
    const receipt=JSON.parse(raw)
    await writeFile(reportPath,raw,{flag:'wx',mode:0o600})
    console.log(JSON.stringify({event:'acceptance_complete',sha,runId,exitCode,reportPath,
      status:receipt.status,qualification_proven:receipt.qualification_proven,cleanup_ok:receipt.cleanup?.ok}))
    return exitCode
  } catch(error) {
    const receipt={status:'failed',qualification_proven:false,source_sha:sha,runId,
      reason:interrupted?'acceptance_interrupted':String(error?.code||error?.message||'acceptance_error').slice(0,120),
      production_data_touched:false}
    await writeFile(reportPath,JSON.stringify(receipt,null,2),{flag:'wx',mode:0o600}).catch(()=>{})
    console.error(JSON.stringify({event:'acceptance_failed',...receipt,reportPath}))
    return 1
  } finally {
    clearTimeout(timer)
    clearTimeout(forceStopTimer)
    process.removeListener('SIGTERM',stop)
    process.removeListener('SIGINT',stop)
    await log.close()
    await rm(folder,{recursive:true,force:true})
  }
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  runDeployedAcceptance(process.argv[2]).then(code=>{process.exitCode=code}).catch(error=>{
    console.error(error.message);process.exitCode=1
  })
}
