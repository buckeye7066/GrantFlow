// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
const mocks=vi.hoisted(()=>({get:vi.fn(),toast:vi.fn()}))
vi.mock('@/lib/anyaClient',()=>({getAnyaRun:mocks.get}))
vi.mock('@/components/ui/use-toast',()=>({toast:mocks.toast}))
beforeEach(()=>{vi.resetModules();vi.useFakeTimers();window.localStorage.clear();mocks.get.mockReset();mocks.toast.mockReset()})
afterEach(()=>vi.useRealTimers())
it('Stop refreshes the thread without announcing a successful new answer',async()=>{
  mocks.get.mockResolvedValue({status:'completed',cancelled:true,degraded:false,assistant_text:'Stopped'})
  const queue=await import('./anyaBackgroundQueue.jsx');const changed=vi.fn();const unsubscribe=queue.subscribeAnyaBackground(changed)
  queue.enqueueAnyaBackgroundRun({runId:'stopped',sessionId:'session'});await vi.runAllTimersAsync()
  expect(changed).toHaveBeenCalledWith(expect.objectContaining({run:expect.objectContaining({cancelled:true})}))
  expect(mocks.toast).not.toHaveBeenCalled();unsubscribe()
})
it('a genuine completed answer still notifies the user',async()=>{
  mocks.get.mockResolvedValue({status:'completed',cancelled:false,degraded:false,assistant_text:'Actual answer'})
  const queue=await import('./anyaBackgroundQueue.jsx');queue.enqueueAnyaBackgroundRun({runId:'finished',sessionId:'session'});await vi.runAllTimersAsync()
  expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({title:'Anya has your answer'}))
})
