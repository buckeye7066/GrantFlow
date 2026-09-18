import {readFileSync} from 'node:fs'
import {parse} from '@babel/parser'
import {expect,it} from 'vitest'
function walk(node,visit,ancestors=[]){if(!node||typeof node!=='object')return;visit(node,ancestors);for(const [key,value] of Object.entries(node)){if(['loc','start','end','extra','tokens','comments'].includes(key))continue;if(Array.isArray(value))value.forEach(child=>walk(child,visit,[...ancestors,node]));else if(value&&typeof value==='object')walk(value,visit,[...ancestors,node])}}
const inferenceFiles=['routes/documents.js','routes/crawlers.js','routes/ai.js','routes/grants.js','routes/legacyFunctions.js','routes/matching.js','routes/nofo.js','routes/profiles.js','services/anyaOrchestrator.js','services/grantApplicationApproachAdvisor.js','services/medicalNecessity.js','services/smartMatcherIntent.js','services/knowledgeBaseProcessor.js','apply/applyEngine.js']
it.each(inferenceFiles)('keyless owner inference is explicit at %s',file=>{
 const ast=parse(readFileSync(new URL('../'+file,import.meta.url),'utf8'),{sourceType:'module'})
 let calls=0
 walk(ast,node=>{if(node.type!=='CallExpression'||node.callee?.name!=='createOpenAIClient')return;calls++;expect(node.arguments[0]?.properties?.some(p=>p.key?.name==='ownerInference'&&p.value?.value===true),file+':'+node.loc.start.line).toBe(true)})
 expect(calls).toBeGreaterThan(0)
})
const queuedFiles=['routes/crawlers.js','routes/profiles.js','routes/documents.js','routes/admin.js','routes/geoCrawl.js','services/anyaToolRegistry.js']
it.each(queuedFiles)('dispatch captures authority before redundant route deferral in %s',file=>{
 const ast=parse(readFileSync(new URL('../'+file,import.meta.url),'utf8'),{sourceType:'module'})
 walk(ast,(node,ancestors)=>{if(node.type!=='CallExpression'||node.callee?.name!=='dispatchCrawlerJob')return
  const deferred=ancestors.some(parent=>parent.type==='CallExpression'&&(['setImmediate','setTimeout'].includes(parent.callee?.name)||(parent.callee?.property?.name==='then'&&parent.callee.object?.callee?.object?.name==='Promise')))
  expect(deferred,file+':'+node.loc.start.line).toBe(false)
 })
})
