import { describe, expect, it, vi } from 'vitest'
vi.mock('server-only',()=>({}))
import { remoteMcpLifecycle } from './lifecycle'
import { endpoint } from './model'
import { abortable, boundedText, decodeReply, remoteMcpRuntime } from './remote'
import type { RemoteMcpStore } from './store'

describe('desktop HTTPS MCP boundaries (offline)',()=>{
    it('rejects unsupported transport and credential-bearing endpoints',()=>{
        for(const url of ['http://example.com/mcp','file:///tmp/mcp','https://u:p@example.com','https://example.com/?token=secret']) expect(()=>endpoint(url)).toThrow()
    })
    it('enforces streaming bytes without trusting content-length',async()=>{
        const response = new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(40));c.enqueue(new Uint8Array(40));c.close()}}))
        await expect(boundedText(response,new AbortController().signal,64)).rejects.toThrow('limit')
    })
    it('ends a finite RPC response on a still-open stream',async()=>{
        const response = new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('data: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n\n'))}}))
        const text=await boundedText(response,new AbortController().signal,1024,1)
        expect(decodeReply(text,'text/event-stream',1)).toEqual({tools:[]})
    })
    it('rejects protocol errors without echoing remote content',()=>{
        expect(()=>decodeReply('{"jsonrpc":"2.0","id":1,"error":{"message":"secret"}}','application/json',1)).toThrow('protocol request failed')
    })
    it('fails closed before network when permission is absent',async()=>{
        const network=vi.fn(), store={lifecycle:remoteMcpLifecycle(),read:async()=>({name:'x',url:'https://example.com/mcp',revision:'1',bearer:'private'})} as unknown as RemoteMcpStore
        const runtime=remoteMcpRuntime(store,async()=>({enabled:true,granted:false}),network)
        await expect(runtime.probe('a','x','1')).rejects.toThrow()
        expect(network).not.toHaveBeenCalled()
    })
    it('returns actual tool results, redacts echoed bearer and rejects edited identity',async()=>{
        let revision='1'; const requests:RequestInit[]=[]
        const store={lifecycle:remoteMcpLifecycle(),read:async()=>({name:'x',url:'https://example.com/mcp',revision,bearer:'private'})} as unknown as RemoteMcpStore
        const network=vi.fn(async(_url:unknown,init?:RequestInit)=>{
            requests.push(init!); const req=JSON.parse(String(init?.body))
            if(req.method==='notifications/initialized')return new Response(null,{status:202})
            const result=req.method==='initialize'?{protocolVersion:'2025-03-26'}:req.method==='tools/list'?{tools:[{name:'hello',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:'private facts'}],isError:false}
            return Response.json({jsonrpc:'2.0',id:req.id,result})
        })
        const runtime=remoteMcpRuntime(store,async()=>({enabled:true,granted:true}),network as typeof fetch)
        expect((await runtime.call('a','x','1','hello',{})).result?.content).toEqual([{ type: 'text', text: '[REDACTED] facts' }])
        expect(requests.every(r=>r.redirect==='manual' && r.credentials==='omit')).toBe(true)
        revision='2'; const before=network.mock.calls.length
        await expect(runtime.call('a','x','1','hello',{})).rejects.toThrow()
        expect(network.mock.calls.length).toBe(before)
    })
})

for (const operation of ['probe','call'] as const) {
    for (const change of ['grant','disabled','revision','url','bearer','removed','disconnect','mutation'] as const) {
        it(`withholds ${operation} output after ${change} during its final response`,async()=>{
            const lifecycle=remoteMcpLifecycle()
            let granted=true,enabled=true,revision='1',url='https://example.com/mcp',bearer='private',removed=false
            let release!:()=>void,mutation:Promise<void>|undefined
            const store={lifecycle,read:async()=>{if(removed)throw new Error('gone');return {name:'x',url,revision,bearer}}} as unknown as RemoteMcpStore
            const network=vi.fn(async(_url:unknown,init?:RequestInit)=>{
                const req=JSON.parse(String(init?.body))
                if(req.method==='notifications/initialized')return new Response(null,{status:202})
                const result=req.method==='initialize'?{protocolVersion:'2025-03-26'}:req.method==='tools/list'?{tools:[{name:'hello',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:'stale result'}],isError:true}
                if(req.method===(operation==='probe'?'tools/list':'tools/call')) {
                    if(change==='grant')granted=false
                    if(change==='disabled')enabled=false
                    if(change==='revision')revision='2'
                    if(change==='url')url='https://changed.example/mcp'
                    if(change==='bearer')bearer='changed'
                    if(change==='removed')removed=true
                    if(change==='disconnect')lifecycle.disconnect('a','x')
                    if(change==='mutation')mutation=lifecycle.mutate('a','x',()=>new Promise<void>(r=>{release=r}))
                }
                return Response.json({jsonrpc:'2.0',id:req.id,result})
            })
            const runtime=remoteMcpRuntime(store,async()=>({enabled,granted}),network as typeof fetch)
            const run=operation==='probe'?runtime.probe('a','x','1'):runtime.call('a','x','1','hello',{})
            await expect(run).rejects.toThrow()
            if(mutation){release();await mutation}
        })
    }
}

it('Stop settles an unresolved authority read and observes its late rejection',async()=>{
 let reject!:(e:Error)=>void
 const pending=new Promise<void>((_,r)=>{reject=r}),stop=new AbortController()
 const result=abortable(pending,stop.signal);stop.abort()
 await expect(result).rejects.toThrow('cancelled')
 reject(new Error('late'))
})
it('owner transition reserves admission until successful persistence settles; shutdown is permanent',async()=>{
 const lifecycle=remoteMcpLifecycle();let finish!:()=>void
 const write=lifecycle.transitionOwner('a',()=>new Promise<void>(r=>{finish=r}))
 expect(()=>lifecycle.admit('a','x',new AbortController())).toThrow()
 await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));finish();await write
 lifecycle.admit('a','x',new AbortController()).release()
 lifecycle.shutdown()
 expect(()=>lifecycle.admit('a','x',new AbortController())).toThrow()
})
