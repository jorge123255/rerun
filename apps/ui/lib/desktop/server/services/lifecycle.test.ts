import {createClient} from '@libsql/client'
import {afterEach,expect,it,vi} from 'vitest'
vi.mock('server-only',()=>({}))
const catalog=vi.hoisted(()=>({manifest:undefined as unknown}))
vi.mock('./catalog/index',()=>({getDesktopServiceManifest:async()=>catalog.manifest,getDesktopServiceMethodAvailability:async(_slug:string,id:string)=>({id,supported:true})}))
vi.mock('./skill-resources',()=>({createServiceSkill:vi.fn(),removeServiceSkill:vi.fn(),verifyServiceSkill:vi.fn()}))
import {serviceManifestSchema} from '@/lib/services/manifest'
import {desktopServicesSchema} from './schema'
import {serviceStore} from './store'
import {createServiceSkill,removeServiceSkill} from './skill-resources'
import {localServiceLifecycle} from './lifecycle'
import type {DesktopRuntime} from '../runtime'
const entries:{db:ReturnType<typeof createClient>;service:ReturnType<typeof localServiceLifecycle>}[]=[]
afterEach(async()=>{for(const {db,service} of entries.splice(0)){service.shutdown();await service.drain();db.close()}vi.clearAllMocks()})
async function setup(){
 const db=createClient({url:'file::memory:'});await db.executeMultiple("CREATE TABLE desktop_agents(id TEXT PRIMARY KEY);INSERT INTO desktop_agents VALUES('owner');"+desktopServicesSchema)
 catalog.manifest=serviceManifestSchema.parse({slug:'microsoft',name:'Microsoft Learn',category:'dev',mcpServers:[{name:'microsoft-learn',transport:'http',url:'https://learn.microsoft.com/api/mcp'}]})
 const store=serviceStore(db,()=>Buffer.alloc(32,7));let grant=true
 const network=vi.fn(async(_url:string,init:RequestInit)=>{if(init.method==='DELETE')return new Response(null,{status:204});const body=JSON.parse(String(init.body));if(!body.id)return new Response(null,{status:202});return Response.json({jsonrpc:'2.0',id:body.id,result:body.method==='initialize'?{protocolVersion:'2025-03-26'}:body.method==='tools/list'?{tools:[{name:'search',inputSchema:{type:'object'}}]}:{content:[]}})})
 const service=localServiceLifecycle(store,async(owner)=>{if(owner!=='owner')throw new Error('owner');return {engineAgentId:'engine',runtime:{launchNonce:'launch'} as DesktopRuntime,skillsRoot:'/fixture/unused',enabled:true,granted:grant}},async()=>{},network as typeof fetch)
 entries.push({db,service});return {db,store,service,network,revoke:()=>{grant=false}}
}
it('keeps exact request receipts, checks revisions and removes only its owned virtual MCP row',async()=>{
 const {service,store,network}=await setup(),signal=new AbortController().signal
 const request={action:'install' as const,requestId:'997d4dfb-190e-4d3b-b538-4571cd6ec4e4',slug:'microsoft',authMethodId:'default',values:{}}
 const first=await service.mutate('owner',request,signal) as {key:string;revision:string;installed:boolean}
 expect(first.installed).toBe(true)
 const calls=network.mock.calls.length
 expect((await service.mutate('owner',request,signal) as {installed:boolean}).installed).toBe(true);expect(network).toHaveBeenCalledTimes(calls)
 await expect(service.mutate('owner',{action:'remove',requestId:crypto.randomUUID(),key:'microsoft',expectedRevision:crypto.randomUUID()},signal)).rejects.toThrow('revision')
 await service.mutate('owner',{action:'disconnect',requestId:crypto.randomUUID(),key:first.key,expectedRevision:first.revision},signal)
 expect((await store.read('owner','microsoft'))?.configured).toBe(false)
 expect((await service.mutate('owner',request,signal) as {installed:boolean}).installed).toBe(false)
})
it('never claims usable merely because a record was saved, and restart makes health unchecked',async()=>{
 const {service,store,revoke}=await setup(),signal=new AbortController().signal;revoke()
 const view=await service.mutate('owner',{action:'install',requestId:crypto.randomUUID(),slug:'microsoft',authMethodId:'default',values:{}},signal) as {installed:boolean}
 expect(view.installed).toBe(false)
 await service.reconcile('owner',signal)
 expect((await store.read('owner','microsoft'))?.health.state).toBe('unchecked')
})

it('rolls back only recorded owned skills after a partial install and never retries its claimed request',async()=>{
 const {service,store,network}=await setup(),signal=new AbortController().signal
 catalog.manifest=serviceManifestSchema.parse({slug:'fixture',name:'Fixture',skills:[{name:'First',body:'Static instructions'},{name:'Second',body:'Static instructions'}],authMethods:[{id:'token',kind:'key',inputs:[{key:'TOKEN',label:'Token',type:'password',secret:true,required:true}],mcpServers:[{name:'fixture',transport:'http',url:'https://example.com/mcp',headers:{Authorization:'Bearer ${input.TOKEN}'}}]}]})
 vi.mocked(createServiceSkill).mockResolvedValueOnce({slug:'svc-0000000000000000-0',directoryIdentity:'1:2',manifestVersion:'version'}).mockRejectedValueOnce(new Error('fixture publication refusal'))
 vi.mocked(removeServiceSkill).mockResolvedValue(undefined)
 const request={action:'install' as const,requestId:crypto.randomUUID(),slug:'fixture',authMethodId:'token',values:{TOKEN:'fixture-only'}}
 await expect(service.mutate('owner',request,signal)).rejects.toThrow('incomplete')
 const record=await store.read('owner','fixture')
 expect(record?.state).toBe('error');expect(record?.configured).toBe(false);expect(record?.skills).toEqual([])
 expect(removeServiceSkill).toHaveBeenCalledTimes(1);expect(network).not.toHaveBeenCalled()
 expect((await service.mutate('owner',request,signal) as {status:string}).status).toBe('unknown')
 expect(createServiceSkill).toHaveBeenCalledTimes(2)
})
