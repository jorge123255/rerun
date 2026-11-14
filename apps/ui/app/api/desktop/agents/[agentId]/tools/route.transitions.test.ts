import {beforeEach,expect,it,vi} from 'vitest'
import {agentConfigSchema} from '@rerun/contracts'
const state=vi.hoisted(()=>({transition:vi.fn(),patch:vi.fn(),config:{} as unknown}))
vi.mock('@/lib/desktop/server/http',()=>({desktopRoute:async(_request:unknown,work:(runtime:unknown)=>unknown)=>work({dataRoot:'/fixture',engine:{origin:'http://127.0.0.1:3001',apiKey:'fixture'}})}))
vi.mock('@/lib/desktop/server/database',()=>({openDesktopDatabase:async()=>({})}))
vi.mock('@/lib/desktop/server/store',()=>({findDesktopAgent:async()=>({engineAgentId:'engine'})}))
vi.mock('@/lib/desktop/server/settings',()=>({engineOf:()=>({})}))
vi.mock('@/lib/desktop/server/mcp-binding',()=>({withDesktopMcpOwnerTransition:state.transition}))
vi.mock('@/lib/engine/client',()=>({getAgent:async()=>({config:state.config}),patchAgent:state.patch,EngineRequestError:class extends Error{status=0}}))
import {GET,PATCH} from './route'
beforeEach(()=>{
 state.config=agentConfigSchema.parse({name:'fixture'})
 state.patch.mockReset().mockResolvedValue({config:state.config})
 state.transition.mockReset().mockImplementation(async(_runtime:unknown,_owner:unknown,write:()=>Promise<unknown>)=>write())
})
for(const [group,id] of [['rerun','localMcpStdio'],['rerun','nativeWriteback'],['codex','workspaceRead'],['codex','workspaceWrite']])it(`reserves owner admission before changing ${group}/${id}`,async()=>{
 let enter!:()=>void
 state.transition.mockImplementation((_runtime:unknown,_owner:unknown,write:()=>Promise<unknown>)=>new Promise(resolve=>{enter=()=>{void write().then(resolve)}}))
 const changed=PATCH(new Request('http://127.0.0.1/api/desktop/agents/owner/tools',{method:'PATCH',body:JSON.stringify({group,id,enabled:false})}),{params:Promise.resolve({agentId:'owner'})})
 await vi.waitFor(()=>expect(state.transition).toHaveBeenCalledTimes(1))
 expect(state.patch).not.toHaveBeenCalled()
 enter();expect((await changed).status).toBe(200)
 expect(state.patch).toHaveBeenCalledTimes(1)
})

it('explains unavailable native grants in App Store mode and permits revoking a saved grant', async () => {
    vi.stubEnv('RERUN_DESKTOP_APP_STORE', '1')
    state.config = agentConfigSchema.parse({ name: 'fixture', tools: { desktopCodexGrants: { workspaceWrite: true } } })
    const context = { params: Promise.resolve({ agentId: 'owner' }) }
    const url = 'http://127.0.0.1/api/desktop/agents/owner/tools'
    const change = (group: string, id: string, enabled: boolean) =>
        PATCH(new Request(url, { method: 'PATCH', body: JSON.stringify({ group, id, enabled }) }), context)
    try {
        const projection = await (await GET(new Request(url), context)).json()
        expect(projection.codex.find((row: { id: string }) => row.id === 'workspaceWrite')).toMatchObject({ available: false, enabled: true })
        expect(projection.rerun.find((row: { id: string }) => row.id === 'nativeWriteback')).toMatchObject({ available: false })
        await expect(change('codex', 'shell', true)).rejects.toMatchObject({ status: 400 })
        await expect(change('rerun', 'nativeWriteback', true)).rejects.toMatchObject({ status: 400 })
        expect(state.patch).not.toHaveBeenCalled()
        expect((await change('codex', 'workspaceWrite', false)).status).toBe(200)
        expect(state.patch).toHaveBeenCalledExactlyOnceWith({}, 'engine', { tools: { desktopCodexGrants: { workspaceWrite: false } } })
    } finally { vi.unstubAllEnvs() }
})
