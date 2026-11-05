import {createClient} from '@libsql/client'
import {afterEach,expect,it,vi} from 'vitest'
vi.mock('server-only',()=>({}))
const catalog=vi.hoisted(()=>({manifest:undefined as unknown}))
vi.mock('./catalog/index',()=>({getDesktopServiceManifest:async()=>({manifest:catalog.manifest}),getDesktopServiceMethodAvailability:async(_slug:string,id:string)=>({id,supported:true})}))
vi.mock('./skill-resources',async importOriginal=>({...await importOriginal<typeof import('./skill-resources')>(),createServiceSkill:vi.fn(),removeServiceSkill:vi.fn(),verifyServiceSkill:vi.fn(async()=>{})}))
import {serviceManifestSchema} from '@/lib/services/manifest'
import {desktopServicesSchema} from './schema'
import {serviceStore} from './store'
import {createServiceSkill,serviceSkillHash} from './skill-resources'
import {serviceSkillMigrationSql} from './skill-journal'
import {localServiceLifecycle} from './lifecycle'
import type {DesktopRuntime} from '../runtime'
const entries:{db:ReturnType<typeof createClient>;service:ReturnType<typeof localServiceLifecycle>}[]=[]
afterEach(async()=>{for(const {db,service} of entries.splice(0)){service.shutdown();await service.drain();db.close()}vi.clearAllMocks()})
async function setup(){
 const db=createClient({url:'file::memory:'});await db.executeMultiple("CREATE TABLE desktop_agents(id TEXT PRIMARY KEY);INSERT INTO desktop_agents VALUES('owner');"+desktopServicesSchema+';'+serviceSkillMigrationSql)
 catalog.manifest=serviceManifestSchema.parse({slug:'microsoft',name:'Microsoft Learn',category:'dev',mcpServers:[{name:'microsoft-learn',transport:'http',url:'https://learn.microsoft.com/api/mcp'}]})
 const store=serviceStore(db,()=>Buffer.alloc(32,7));let grant=true
 const network=vi.fn(async(_url:string,init:RequestInit)=>{if(init.method==='DELETE')return new Response(null,{status:204});const body=JSON.parse(String(init.body));if(!body.id)return new Response(null,{status:202});return Response.json({jsonrpc:'2.0',id:body.id,result:body.method==='initialize'?{protocolVersion:'2025-03-26'}:body.method==='tools/list'?{tools:[{name:'search',inputSchema:{type:'object'}}]}:{content:[]}})})
 const syncRegistry=vi.fn(async()=>{})
 const service=localServiceLifecycle(store,async(owner)=>{if(owner!=='owner')throw new Error('owner');return {engineAgentId:'engine',runtime:{launchNonce:'launch'} as DesktopRuntime,skillsRoot:'/fixture/unused',enabled:true,granted:grant}},async()=>{},network as typeof fetch,syncRegistry)
 entries.push({db,service});return {db,store,service,network,syncRegistry,revoke:()=>{grant=false}}
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
 await service.reconcileOwners(signal)
 expect((await store.read('owner','microsoft'))?.health.state).toBe('unchecked')
})

it('publishes bundled skills and reconnects without replacing or duplicating them',async()=>{
 const {service,store,syncRegistry}=await setup(),signal=new AbortController().signal
 catalog.manifest=serviceManifestSchema.parse({slug:'fixture',name:'Fixture',skills:[{name:'First',body:'Static instructions'}],authMethods:[{id:'token',kind:'key',inputs:[{key:'TOKEN',label:'Token',type:'password',secret:true,required:true}],mcpServers:[{name:'fixture',transport:'http',url:'https://example.com/mcp',headers:{Authorization:'Bearer ${input.TOKEN}'}}]}]})
 vi.mocked(createServiceSkill).mockImplementation(async(_root,record,index,skill,_guard,journal)=>{
  const row=await journal.reserve(record,index,serviceSkillHash(skill))
  if(row.resource)return row.resource
  const resource={slug:row.slug,directoryIdentity:'1:2',manifestVersion:'1:2:3:4:5',contentHash:row.hash}
  await journal.update(row,'published',resource);return resource
 })
 const request={action:'install' as const,requestId:crypto.randomUUID(),slug:'fixture',authMethodId:'token',values:{TOKEN:'fixture-only'}}
 const first=await service.mutate('owner',request,signal) as {key:string;revision:string;installed:boolean}
 expect(first.installed).toBe(true)
 expect((await store.read('owner','fixture'))?.skills).toHaveLength(1)
 expect(createServiceSkill).toHaveBeenCalledTimes(1);expect(syncRegistry).toHaveBeenCalled()
 await service.mutate('owner',{action:'disconnect',requestId:crypto.randomUUID(),key:first.key,expectedRevision:first.revision},signal)
 const again=await service.mutate('owner',{...request,requestId:crypto.randomUUID()},signal) as {installed:boolean}
 expect(again.installed).toBe(true);expect(createServiceSkill).toHaveBeenCalledTimes(2)
 expect((await store.read('owner','fixture'))?.skills).toHaveLength(1)
})
it('reconciles an interrupted partial install before allowing tool use',async()=>{
 const {service,store}=await setup(),signal=new AbortController().signal
 catalog.manifest=serviceManifestSchema.parse({slug:'fixture',name:'Fixture',skills:[{name:'First',body:'Static instructions'}],mcpServers:[{name:'fixture',transport:'http',url:'https://example.com/mcp'}]})
 vi.mocked(createServiceSkill).mockImplementation(async(_root,record,index,skill,_guard,journal)=>{
  const row=await journal.reserve(record,index,serviceSkillHash(skill))
  if(row.resource)return row.resource
  const resource={slug:row.slug,directoryIdentity:'1:2',manifestVersion:'1:2:3:4:5',contentHash:row.hash}
  await journal.update(row,'published',resource);return resource
 })
 const request={action:'install' as const,requestId:crypto.randomUUID(),slug:'fixture',authMethodId:'default',values:{}}
 const first=await service.mutate('owner',request,signal) as {revision:string}
 const saved=(await store.read('owner','fixture'))!
 saved.state='error';saved.revision=crypto.randomUUID();await store.update(saved,first.revision)
 const retry=await service.mutate('owner',{...request,requestId:crypto.randomUUID()},signal) as {installed:boolean}
 expect(retry.installed).toBe(true);expect(createServiceSkill).toHaveBeenCalledTimes(2)
})
