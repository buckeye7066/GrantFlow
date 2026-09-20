import {createServer} from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {pathToFileURL} from 'node:url';
export const LOCAL_MODELS=new Set(['llama3.2:latest','llama3.2:1b','qwen2.5-coder:7b','gemma3:4b']);
const failure=(status)=>Object.assign(new Error('Request could not be completed'),{status});
function send(res,status,body) {
  if(res.destroyed||res.writableEnded)return;
  res.writeHead(status,{'content-type':'application/json','cache-control':'no-store',...(status===429?{'retry-after':'3'}:{})});
  res.end(JSON.stringify(body));
}
async function boundedText(stream,limit) {
  let size=0;const chunks=[];
  for await(const chunk of stream){size+=chunk.length;if(size>limit)throw failure(413);chunks.push(Buffer.from(chunk));}
  return Buffer.concat(chunks).toString('utf8');
}
/** Token-protected text-only bridge. The raw Ollama management API stays private. */
export function createGateway({token,model='llama3.2:latest',fetchImpl=fetch,timeoutMs=110000,now=Date.now}={}) {
  if(typeof token!=='string'||token.length<32||!LOCAL_MODELS.has(model))throw new Error('Invalid private gateway configuration');
  const expected=Buffer.from('Bearer '+token);let active=0;let windowAt=now();let count=0;
  return async(req,res)=>{
    const header=req.headers.authorization;
    const received=Buffer.from(typeof header==='string'&&header.length<1024?header:'');
    if(received.length!==expected.length||!timingSafeEqual(received,expected))return send(res,401,{error:'Unauthorized'});
    if(req.method==='GET'&&req.url==='/health')return send(res,200,{service:'local-free-ai',model,billing_mode:'free_or_local',active});
    if(req.method!=='POST'||req.url!=='/v1/chat/completions')return send(res,404,{error:'Not found'});
    if(active)return send(res,429,{error:'Local model busy'});
    if(now()-windowAt>=60000){windowAt=now();count=0;}
    if(count>=30)return send(res,429,{error:'Local request limit reached'});
    active++;count++;const cancel=new AbortController();
    const close=()=>{if(!res.writableEnded)cancel.abort();};res.once('close',close);
    try {
      if(!String(req.headers['content-type']||'').startsWith('application/json'))throw failure(400);
      const raw=await boundedText(req,262144);let input;
      try{input=JSON.parse(raw);}catch{throw failure(400);}
      if(!input||typeof input!=='object'||Array.isArray(input))throw failure(400);
      const maxTokens=input.max_tokens??input.max_completion_tokens??2048;
      if(input.model!==model||input.stream===true||input.tools||input.functions||input.tool_choice||input.function_call||
        !Array.isArray(input.messages)||input.messages.length<1||input.messages.length>64||
        !input.messages.every(m=>m&&['system','developer','user','assistant'].includes(m.role)&&typeof m.content==='string')||
        !Number.isInteger(maxTokens)||maxTokens<1||maxTokens>8192||
        (input.temperature!==undefined&&(!Number.isFinite(input.temperature)||input.temperature<0||input.temperature>2))||
        (input.response_format&&!['json_object','json_schema'].includes(input.response_format.type)))throw failure(400);
      const payload={model,messages:input.messages.map(({role,content})=>({role:role==='developer'?'system':role,content})),
        max_tokens:maxTokens,temperature:input.temperature??0,stream:false,
        ...(input.response_format?{response_format:input.response_format}:{})};
      const upstream=await fetchImpl('http://127.0.0.1:11434/v1/chat/completions',{
        method:'POST',redirect:'error',signal:AbortSignal.any([cancel.signal,AbortSignal.timeout(timeoutMs)]),
        headers:{'content-type':'application/json'},body:JSON.stringify(payload),
      });
      if(!upstream.ok){await upstream.body?.cancel();throw failure(502);}
      let answer;try{answer=JSON.parse(await boundedText(upstream.body,524288));}catch{throw failure(502);}
      const choice=answer.choices?.[0];
      if(answer.model!==model||choice?.finish_reason!=='stop'||typeof choice.message?.content!=='string'||!choice.message.content.trim())throw failure(502);
      return send(res,200,{...answer,provider:'free:home-ollama',billing_mode:'free_or_local'});
    }catch(error){return send(res,error.status??(error.name==='TimeoutError'?504:502),{error:'Local model request failed'});}
    finally{active--;res.removeListener('close',close);}
  };
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const handler=createGateway({token:process.env.LOCAL_FREE_AI_TOKEN,model:process.env.LOCAL_FREE_AI_MODEL||'llama3.2:latest'});
  const server=createServer(handler);server.requestTimeout=15000;server.headersTimeout=10000;
  server.listen(11435,'127.0.0.1',()=>console.log('local-free-ai listening on loopback:11435'));
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{server.closeAllConnections();server.close();});
}
