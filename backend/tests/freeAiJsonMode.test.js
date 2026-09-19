import {describe,it,expect,vi} from 'vitest';
import {getConfiguredFreeAiRoutes,invokeFreeJsonRoutes,invokeFreeTextRoutes} from '../utils/freeAiRoutes.js';
function route(enabled){return getConfiguredFreeAiRoutes({FREE_AI_ROUTES:JSON.stringify([{id:'local',base_url:'http://127.0.0.1:11434/v1',model:'llama3.2:1b',json_mode:enabled}])});}
function client(){const create=vi.fn(async()=>({model:'llama3.2:1b',choices:[{message:{content:'{"amount":5000}'},finish_reason:'stop'}]}));return {create,factory:()=>({chat:{completions:{create}}})};}
describe('opt-in structured output for compatible free routes',()=>{
 it('requests JSON mode only when the configured route supports it',async()=>{
  const {create,factory}=client();const result=await invokeFreeJsonRoutes({routes:route(true),prompt:'Extract facts',clientFactory:factory,timeoutMs:1000});
  expect(result.ok).toBe(true);expect(result.billing_mode).toBe('free_or_local');expect(create.mock.calls[0][0].response_format).toEqual({type:'json_object'});
 });
 it('preserves ordinary compatible endpoints without the opt-in',async()=>{
  const {create,factory}=client();await invokeFreeJsonRoutes({routes:route(false),prompt:'Extract facts',clientFactory:factory,timeoutMs:1000});expect(create.mock.calls[0][0]).not.toHaveProperty('response_format');
 });
 it('does not impose JSON mode on a text request',async()=>{
  const {create,factory}=client();await invokeFreeTextRoutes({routes:route(true),prompt:'Explain a concept',clientFactory:factory,timeoutMs:1000});expect(create.mock.calls[0][0]).not.toHaveProperty('response_format');
 });
});
