import {pathToFileURL} from 'node:url';
import {LOCAL_MODELS} from './gateway.mjs';

/** Read-only verification, before the installer writes configuration or tasks. */
export async function verifyLocalModel(model,{fetchImpl=globalThis.fetch,timeoutMs=5000}={}) {
 if(!LOCAL_MODELS.has(model))throw new Error('Unsupported local model');
 let catalog;
 try {
  const response=await fetchImpl('http://127.0.0.1:11434/api/tags',{
   redirect:'error',signal:AbortSignal.timeout(Math.max(1,Math.min(10000,timeoutMs))),
  });
  if(!response.ok)throw new Error('Local catalog request failed');
  const chunks=[];let bytes=0;
  for await(const chunk of response.body){bytes+=chunk.length;if(bytes>1048576)throw new Error('Local catalog too large');chunks.push(Buffer.from(chunk));}
  catalog=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(!Array.isArray(catalog?.models))throw new Error('Invalid local catalog');
 }catch{throw new Error('Local model catalog unavailable; start Ollama before installation');}
 if(!catalog.models.some(entry=>entry?.name===model)){
  throw new Error(`Selected model ${model} is not installed; run ollama pull ${model} before installation`);
 }
 return true;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{await verifyLocalModel(process.argv[2]);console.log('Selected local model verified.');}
 catch(error){console.error(error.message);process.exitCode=1;}
}
