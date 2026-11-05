import {afterEach,expect,it,vi} from 'vitest'
vi.mock('server-only',()=>({}))
vi.mock('../auth',async importOriginal=>({...await importOriginal<typeof import('../auth')>(),authenticateDesktopRequest:vi.fn(async()=>({}))}))
import {MCP_ADMISSION_TIMEOUT_MS,remoteMcpApi} from './api'
import type {RemoteMcpStore} from './store'
import type {remoteMcpRuntime} from './remote'
import {remoteMcpLifecycle} from './lifecycle'
afterEach(()=>vi.useRealTimers())

it('a stale disconnect cannot cancel a newly configured server',async()=>{
 const store={read:vi.fn(async()=>({revision:'new'}))} as unknown as RemoteMcpStore
 const runtime={watch:()=>()=>{},disconnect:vi.fn()} as unknown as ReturnType<typeof remoteMcpRuntime>
 const api=remoteMcpApi(store,runtime,async()=>({enabled:true,granted:true}))
 const request=(revision:string)=>new Request('https://localhost/mcp',{method:'POST',body:JSON.stringify({name:'x',revision,action:'disconnect'})})
 expect((await api(request('old'),'a')).status).toBe(409)
 expect(runtime.disconnect).not.toHaveBeenCalled()
 expect((await api(request('new'),'a')).status).toBe(200)
 expect(runtime.disconnect).toHaveBeenCalledExactlyOnceWith('a','x')
})

it('a config transition during the disconnect revision read prevents stale invalidation',async()=>{
 let resolve!:(value:{revision:string})=>void,entered!:()=>void,changed=false
 const reading=new Promise<void>(yes=>{entered=yes})
 const store={read:vi.fn(()=>{entered();return new Promise<{revision:string}>(yes=>{resolve=yes})})} as unknown as RemoteMcpStore
 const runtime={watch:()=>()=>{if(changed)throw new Error('changed')},disconnect:vi.fn()} as unknown as ReturnType<typeof remoteMcpRuntime>
 const pending=remoteMcpApi(store,runtime,async()=>({enabled:true,granted:true}))(new Request('https://localhost/mcp',{method:'POST',body:JSON.stringify({name:'x',revision:'old',action:'disconnect'})}),'a')
 await reading;changed=true;resolve({revision:'old'})
 expect((await pending).ok).toBe(false)
 expect(runtime.disconnect).not.toHaveBeenCalled()
})

it('a management PUT admitted before shutdown cannot persist a body delivered afterward',async()=>{
 const lifecycle=remoteMcpLifecycle(),persist=vi.fn(async()=>[])
 let body!:ReadableStreamDefaultController<Uint8Array>,admitted!:()=>void
 const admission=new Promise<void>(resolve=>{admitted=resolve})
 const stream=new ReadableStream<Uint8Array>({start(controller){body=controller}})
 const store={save:(_agent:string,input:{name:string})=>lifecycle.mutate('a',input.name,persist)} as unknown as RemoteMcpStore
 const request=new Request('https://localhost/mcp',{method:'PUT',body:stream,duplex:'half'} as RequestInit & {duplex:'half'})
 const response=remoteMcpApi(store,{} as ReturnType<typeof remoteMcpRuntime>,async()=>{admitted();return {enabled:true,granted:true}})(request,'a')
 await admission;lifecycle.shutdown()
 body.enqueue(new TextEncoder().encode(JSON.stringify({name:'x',url:'https://example.com/mcp'})));body.close()
 expect((await response).ok).toBe(false)
 expect(persist).not.toHaveBeenCalled()
})
for(const reason of ['abort','deadline','already-aborted'] as const)for(const late of ['resolve','reject'] as const)for(const method of ['POST','PUT','DELETE'] as const)it(`${method} refuses ${reason} admission and ignores late ${late}`,async()=>{
 vi.useFakeTimers()
 let resolve!:(v:{enabled:boolean;granted:boolean})=>void,reject!:(e:Error)=>void
 const authority=new Promise<{enabled:boolean;granted:boolean}>((yes,no)=>{resolve=yes;reject=no})
 const access=vi.fn(()=>authority)
 const store={list:vi.fn(),save:vi.fn(),remove:vi.fn()} as unknown as RemoteMcpStore
 const runtime={probe:vi.fn(),watch:vi.fn(),disconnect:vi.fn(),validate:vi.fn()} as unknown as ReturnType<typeof remoteMcpRuntime>
 const stop=new AbortController()
 if(reason==='already-aborted')stop.abort()
 const result=remoteMcpApi(store,runtime,access)(new Request('https://localhost/mcp',{method,signal:stop.signal,body:JSON.stringify({name:'x',revision:'1',url:'https://example.com/mcp',action:'probe'})}),'a')
 await Promise.resolve();await Promise.resolve();await Promise.resolve()
 if(reason==='abort')stop.abort()
 if(reason==='deadline')await vi.advanceTimersByTimeAsync(MCP_ADMISSION_TIMEOUT_MS)
 expect((await result).ok).toBe(false)
 // An already-aborted request must never acquire this authority promise.
 if(reason!=='already-aborted'){if(late==='resolve')resolve({enabled:true,granted:true});else reject(new Error('late authority failure'))}
 await Promise.resolve();await Promise.resolve()
 expect(runtime.probe).not.toHaveBeenCalled();expect(runtime.watch).not.toHaveBeenCalled()
 expect(store.list).not.toHaveBeenCalled();expect(store.save).not.toHaveBeenCalled();expect(store.remove).not.toHaveBeenCalled()
 if(reason==='already-aborted')expect(access).not.toHaveBeenCalled()
})
