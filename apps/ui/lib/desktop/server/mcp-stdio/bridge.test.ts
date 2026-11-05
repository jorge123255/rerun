import {expect,it,vi} from 'vitest'
vi.mock('server-only',()=>({}))
vi.mock('../auth',()=>({authenticateDesktopEngineRequest:async()=>({})}))
import {stdioEngineBridge} from './bridge'
import type {stdioRuntime} from './runtime'
const run={engineAgentId:'engine',sessionId:'session',runId:'run'}
const request=(action:string,extra:Record<string,unknown>={})=>new Request('http://127.0.0.1/api/desktop/engine/mcp-stdio',{method:'POST',body:JSON.stringify({...run,action,...extra})})
it('releases a still-opening catalog by exact run and rejects late admission',async()=>{
 let began!:()=>void,finish!:()=>void
 const starting=new Promise<void>(resolve=>{began=resolve}),gate=new Promise<void>(resolve=>{finish=resolve})
 const releaseRun=vi.fn(async()=>{}),tools=vi.fn(async(_owner:unknown,_run:unknown,_life:AbortSignal,admission:AbortSignal)=>{began();await gate;admission.throwIfAborted();return []})
 const runtime={tools,releaseRun,shutdown:vi.fn(async()=>{})} as unknown as ReturnType<typeof stdioRuntime>
 const bridge=stdioEngineBridge(runtime,async()=> 'owner')
 const opening=bridge.api(request('catalog'));await starting
 expect((await bridge.api(request('release'))).ok).toBe(true)
 finish();expect((await opening).ok).toBe(false)
 expect(releaseRun).toHaveBeenCalledWith('owner',expect.objectContaining(run))
 expect((await bridge.api(request('catalog'))).ok).toBe(false)
 expect(tools).toHaveBeenCalledTimes(1)
})
it('permanently closes admission on shutdown even when the owner has no connections',async()=>{
 const tools=vi.fn(async()=>[]),runtime={tools,releaseRun:vi.fn(async()=>{}),shutdown:vi.fn(async()=>{})} as unknown as ReturnType<typeof stdioRuntime>
 const bridge=stdioEngineBridge(runtime,async()=> 'owner')
 await bridge.shutdown()
 expect((await bridge.api(request('catalog'))).ok).toBe(false)
 expect(tools).not.toHaveBeenCalled()
})
