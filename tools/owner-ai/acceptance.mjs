import {probeProvider,executeJob} from './officialCli.mjs'
import {assertAcceptanceOperator,runAcceptanceSubscription} from '../../backend/utils/acceptanceSubscriptionContext.js'

/** Native login belongs to the local operator CLI, not to the deployed application. */
export async function runWithCodexAcceptance(work){
 assertAcceptanceOperator()
 const authFailure=()=>Object.assign(new Error('The official Codex client must prove ChatGPT sign-in before acceptance'),{code:'ACCEPTANCE_SUBSCRIPTION_AUTH_FAILED'})
 const env={}
 for(const key of ['PATH','Path','SystemRoot','WINDIR','COMSPEC','PATHEXT','TEMP','TMP','LOCALAPPDATA','USERPROFILE','HOME','OWNER_AI_CODEX_MODEL']){
  if(process.env[key])env[key]=process.env[key]
 }
 if(!env.LOCALAPPDATA)throw authFailure()
 let status
 try{status=await probeProvider('codex',{env,signal:AbortSignal.timeout(12000)})}catch{throw authFailure()}
 if(status!=='ready')throw authFailure()
 return runAcceptanceSubscription(executeJob,env,work)
}
