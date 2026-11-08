import {it,expect,vi} from 'vitest'
vi.mock('server-only',()=>({}))
import {remoteMcpLifecycle} from './lifecycle'
import {remoteMcpTools} from './tools'
import {abortable, remoteMcpRuntime} from './remote'
import type {RemoteMcpStore} from './store'

function unavailableServer(change?: 'Stop' | 'grant revocation' | 'registration change') {
    const lifecycle = remoteMcpLifecycle()
    const run = new AbortController()
    let granted = true
    const servers = ['auth', 'healthy'].map(name => ({ name, url: `https://${name}.example/mcp`, revision: '1', transport: 'http', hasBearer: false }))
    const store = {
        lifecycle,
        list: async () => servers,
        read: async (_owner: string, name: string) => ({ ...servers.find(server => server.name === name)!, bearer: '' }),
    } as unknown as RemoteMcpStore
    const network = vi.fn(async (url: string, init?: RequestInit) => {
        if (url === servers[0]!.url) {
            if (change === 'Stop') run.abort(new Error('Run stopped'))
            if (change === 'grant revocation') granted = false
            if (change === 'registration change') lifecycle.disconnect('owner', 'auth')
            return new Response(null, { status: 401 })
        }
        const request = JSON.parse(String(init?.body))
        if (request.method === 'notifications/initialized') return new Response(null, { status: 202 })
        const result = request.method === 'initialize' ? { protocolVersion: '2025-03-26' } : { tools: [{ name: 'hello', inputSchema: { type: 'object' } }] }
        return Response.json({ jsonrpc: '2.0', id: request.id, result })
    })
    const runtime = remoteMcpRuntime(store, async () => ({ enabled: true, granted }), network as typeof fetch)
    return { network, discover: () => remoteMcpTools('owner', store, runtime, run.signal) }
}

it('keeps chat tool discovery available when a registered HTTPS server requires sign-in', async () => {
    const { network, discover } = unavailableServer()
    expect((await discover()).map(tool => tool.name)).toEqual(['healthy_hello'])
    expect(network.mock.calls.map(([url]) => url)).toEqual([
        'https://auth.example/mcp',
        'https://healthy.example/mcp',
        'https://healthy.example/mcp',
        'https://healthy.example/mcp',
    ])
})

it.each([
    ['Stop', 'Run stopped'],
    ['grant revocation', 'MCP capability unavailable'],
    ['registration change', 'MCP capability invalidated'],
] as const)('refuses to continue catalog discovery after %s during a failed probe', async (change, reason) => {
    const { network, discover } = unavailableServer(change)
    await expect(discover()).rejects.toThrow(reason)
    expect(network).toHaveBeenCalledTimes(1)
})

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
