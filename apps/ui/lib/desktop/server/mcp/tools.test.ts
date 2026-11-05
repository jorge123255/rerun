import {it,expect,vi} from 'vitest'
vi.mock('server-only',()=>({}))
import {remoteMcpTools} from './tools'
import {abortable, type remoteMcpRuntime} from './remote'
import type {RemoteMcpStore} from './store'
it('withholds call output when call Stop fires during final validation',async()=>{
 let enter!:()=>void
 const entered=new Promise<void>(r=>{enter=r})
 let executing=false
 const runtime={
  watch:()=>()=>{},
  probe:async()=>({tools:[{name:'hello',inputSchema:{type:'object'}}]}),
  call:async()=>{executing=true;return {result:{content:[]}}},
  validate:async(_a:string,_n:string,_r:string,signal:AbortSignal)=>{
   if(executing){enter();await abortable(new Promise<void>(()=>{}),signal)}
  },
 } as unknown as ReturnType<typeof remoteMcpRuntime>
 const store={list:async()=>[{name:'x',revision:'1'}]} as unknown as RemoteMcpStore
 const run=new AbortController(),call=new AbortController()
 const tools=await remoteMcpTools('a',store,runtime,run.signal)
 const result=tools[0].execute({},call.signal)
 await entered;call.abort()
 await expect(result).rejects.toThrow('cancelled')
 expect(run.signal.aborted).toBe(false)
})
