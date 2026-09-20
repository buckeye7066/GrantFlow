import {probeProvider,executeJob} from './officialCli.mjs'
import {assertAcceptanceOperator,runAcceptanceSubscription} from '../../backend/utils/acceptanceSubscriptionContext.js'

/** Native login belongs to the local operator CLI, not to the deployed application. */
export async function runWithCodexAcceptance(work){
 assertAcceptanceOperator()
 const env={}
 for(const key of ['PATH','Path','SystemRoot','WINDIR','COMSPEC','PATHEXT','TEMP','TMP','LOCALAPPDATA','USERPROFILE','HOME','OWNER_AI_CODEX_MODEL']){
  if(process.env[key])env[key]=process.env[key]
 }
 if(!env.LOCALAPPDATA)throw new Error('The existing Windows ChatGPT client profile is required')
 if(await probeProvider('codex',{env,signal:AbortSignal.timeout(12000)})!=='ready')throw new Error('The official Codex client must be signed in with ChatGPT before acceptance')
 return runAcceptanceSubscription(executeJob,env,work)
}
