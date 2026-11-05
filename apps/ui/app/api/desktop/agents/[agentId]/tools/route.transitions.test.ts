import {beforeEach,expect,it,vi} from 'vitest'
import {agentConfigSchema} from '@rerun/contracts'
const state=vi.hoisted(()=>({transition:vi.fn(),patch:vi.fn(),config:{} as unknown}))
vi.mock('@/lib/desktop/server/http',()=>({desktopRoute:async(_request:unknown,work:(runtime:unknown)=>unknown)=>work({dataRoot:'/fixture',engine:{origin:'http://127.0.0.1:3001',apiKey:'fixture'}})}))
vi.mock('@/lib/desktop/server/database',()=>({openDesktopDatabase:async()=>({})}))
vi.mock('@/lib/desktop/server/store',()=>({findDesktopAgent:async()=>({engineAgentId:'engine'})}))
vi.mock('@/lib/desktop/server/settings',()=>({engineOf:()=>({})}))
vi.mock('@/lib/desktop/server/mcp-binding',()=>({withDesktopMcpOwnerTransition:state.transition}))
vi.mock('@/lib/engine/client',()=>({getAgent:async()=>({config:state.config}),patchAgent:state.patch,EngineRequestError:class extends Error{status=0}}))
import {PATCH} from './route'
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
