import {withinSubscriptionOutputLimit} from '../../shared/subscriptionOutput.js'
import {AsyncLocalStorage} from 'node:async_hooks'
import {realpathSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {withLLMTimeout} from './llmTimeout.js'

const scope=new AsyncLocalStorage()
const canonicalEntry=fileURLToPath(new URL('../../scripts/grantflow-acceptance-50.mjs',import.meta.url))
const provider='subscription:codex'
export function getAcceptanceSubscription(){return scope.getStore()??null}
function explicitlySelected(){
 const args=process.argv.slice(2)
 const selected=args.includes('--subscription=codex')||args.some((arg,index)=>arg==='--subscription'&&args[index+1]==='codex')
 try{return selected&&realpathSync(process.argv[1])===realpathSync(canonicalEntry)&&process.env.NODE_ENV!=='production'}catch{return false}
}
export function assertAcceptanceOperator(){
 if(!explicitlySelected()||scope.getStore())throw new Error('Subscription mode requires an explicit canonical local acceptance command')
}
function isolateModelEnvironment(){
 const snapshot=new Map()
 const remove=key=>{if(!snapshot.has(key))snapshot.set(key,process.env[key]);delete process.env[key]}
 for(const key of Object.keys(process.env)){
  if(/^(OPENAI|ANTHROPIC|FREE_AI|OLLAMA)(_|$)/.test(key)||key==='OWNER_AI_BRIDGE_TOKEN')remove(key)
 }
 for(const [key,value] of Object.entries({AI_PAID_ROUTES:'[]',FREE_AI_ROUTES:'[]',OWNER_AI_BRIDGE_ENABLED:'false',OWNER_AI_ALLOW_PAID_FALLBACK:'false'})){
  if(!snapshot.has(key))snapshot.set(key,process.env[key]);process.env[key]=value
 }
 return ()=>{for(const [key,value] of snapshot){if(value===undefined)delete process.env[key];else process.env[key]=value}}
}

/** Explicit local CLI authority only. No customer identity or owner proof is manufactured. */
export async function runAcceptanceSubscription(executeJob,env,work){
 assertAcceptanceOperator()
 if(typeof executeJob!=='function'||typeof work!=='function')throw new Error('An authenticated local acceptance executor is required')
 const restore=isolateModelEnvironment()
 let active=true
 const counts={completed_calls:0,failed_calls:0,aborted_calls:0,input_tokens:0,output_tokens:0}
 const context={provider,summary:()=>({mode:'explicit_local_operator',provider,billing_mode:'subscription',...counts}),
  async invoke({system=null,prompt,format='text',maxTokens=1200,timeoutMs=20000,signal}={}){
   const failed=(error=null)=>{
    const aborted=!active||signal?.aborted===true
    if(aborted)counts.aborted_calls++;else counts.failed_calls++
    return {ok:false,provider,billing_mode:'subscription',raw:null,json:null,text:null,freeRouteErrors:[],subscription_unavailable:!aborted,aborted,timedOut:Boolean(error?.isTimeout||error?.code==='LLM_TIMEOUT'),error:aborted?(signal?.reason||new DOMException('Operation cancelled','AbortError')):error}
   }
   if(!active||signal?.aborted||!Number.isSafeInteger(maxTokens)||maxTokens<2||maxTokens>32000||!['text','json'].includes(format))return failed()
   const budget=Number(timeoutMs??20000)
   if(!Number.isFinite(budget)||budget<=0)return failed()
   try{
    const result=await withLLMTimeout(attemptSignal=>executeJob({providers:['codex'],format,system,
     prompt:typeof prompt==='string'?prompt:JSON.stringify(prompt??''),maxTokens,timeoutMs:Math.min(120000,budget)},
     {env,signal:attemptSignal}),{timeoutMs:Math.min(120000,budget),signal,label:'Acceptance subscription request'})
    if(!active||signal?.aborted||result?.ok!==true||result.complete!==true||result.provider!==provider||result.billing_mode!=='subscription'||
     typeof result.raw!=='string'||!result.raw.trim()||typeof result.model!=='string'||!result.model.trim()||
     !withinSubscriptionOutputLimit(result,maxTokens))return failed()
    let json=null
    if(format==='json'){try{json=JSON.parse(result.raw)}catch{return failed()};if(!json||typeof json!=='object')return failed()}
    counts.completed_calls++
    counts.input_tokens+=Number.isSafeInteger(result.usage.input_tokens)?result.usage.input_tokens:0
    counts.output_tokens+=result.usage.output_tokens
    return {...result,json,...(format==='text'?{text:result.raw}:{})}
   }catch(error){return failed(error)}
  },
 }
 try{return await scope.run(context,work)}finally{active=false;restore()}
}
