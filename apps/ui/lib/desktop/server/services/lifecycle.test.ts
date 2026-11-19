import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createClient} from '@libsql/client'
import {afterEach,expect,it,vi} from 'vitest'
vi.mock('server-only',()=>({}))
vi.mock('../auth', async original => ({
    ...await original<typeof import('../auth')>(),
    authenticateDesktopEngineRequest: vi.fn(async (request: Request) => {
        if (request.headers.get('Authorization') !== 'Bearer fixture-engine') throw new Error('Unauthorized')
    }),
}))
const catalog=vi.hoisted(()=>({manifest:undefined as unknown}))
vi.mock('./catalog/index',()=>({getDesktopServiceManifest:async()=>({manifest:catalog.manifest}),getDesktopServiceMethodAvailability:async(_slug:string,id:string)=>({id,supported:true})}))
vi.mock('./skill-resources',async importOriginal=>({...await importOriginal<typeof import('./skill-resources')>(),createServiceSkill:vi.fn(),removeServiceSkill:vi.fn(),verifyServiceSkill:vi.fn(async()=>{})}))
import {serviceManifestSchema} from '@/lib/services/manifest'
import { initializeDesktopRound75 } from '../round75-schema'
import {desktopServicesSchema} from './schema'
import {serviceStore} from './store'
import {createServiceSkill,serviceSkillHash} from './skill-resources'
import {serviceSkillMigrationSql} from './skill-journal'
import {localServiceLifecycle} from './lifecycle'
import {serviceEngineBridge} from './bridge'
import type {DesktopRuntime} from '../runtime'
const entries:{db:ReturnType<typeof createClient>;service:ReturnType<typeof localServiceLifecycle>}[]=[]
afterEach(async()=>{for(const {db,service} of entries.splice(0)){service.shutdown();await service.drain();db.close()}vi.clearAllMocks()})
async function setup(url='file::memory:'){
 const db=createClient({url});await db.executeMultiple("CREATE TABLE desktop_agents(id TEXT PRIMARY KEY);INSERT INTO desktop_agents VALUES('owner');"+desktopServicesSchema+';'+serviceSkillMigrationSql)
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


it('publishes a Vault app through the Services bridge with the engine result shape and durable call admission', async () => {
    const {store, service, revoke} = await setup()
    const execute = vi.fn(async () => ({ source: 'remote_mcp', untrusted: true, result: { content: [] } }))
    const ownerForRun = vi.fn(async () => 'owner')
    const bridge = serviceEngineBridge(store, service, ownerForRun, undefined, async () => [
        { name: 'vault_example_read', description: 'Read fixture', inputSchema: { type: 'object' }, execute },
    ])
    const identity = { engineAgentId: 'engine', sessionId: 'chat', runId: 'run' }
    const post = (body: object, authorization = 'Bearer fixture-engine') => bridge.api(new Request('http://127.0.0.1/api/desktop/internal/services', {
        method: 'POST', headers: { authorization }, body: JSON.stringify({ ...identity, ...body }),
    }))
    try {
        expect((await post({ action: 'catalog' }, '')).status).toBe(400)
        const catalogResponse = await post({ action: 'catalog' })
        expect(catalogResponse.status).toBe(200)
        const catalog = await catalogResponse.json()
        expect(catalog.tools[0].name).toBe('vault_example_read')
        const call = { action: 'call', catalogId: catalog.catalogId, capabilityId: catalog.tools[0].capabilityId, toolCallId: 'call-1', arguments: {} }
        expect((await post({ ...call, runId: 'foreign-run' })).status).toBe(400)
        expect(await (await post(call)).json()).toEqual({ toolCallId: 'call-1', result: { source: 'local_service', untrusted: true, result: { content: [] } } })
        expect((await post(call)).status).toBe(400)
        revoke()
        expect((await post({ ...call, toolCallId: 'call-2' })).status).toBe(400)
        expect(execute).toHaveBeenCalledTimes(1)
    } finally { await bridge.shutdown() }
})

it('stores each Chief call against its owned turn and rejects duplicate, foreign and late calls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chief-service-calls-'))
    const {db, store, service} = await setup('file:' + join(root, 'apps.db'))
    await db.executeMultiple(`PRAGMA foreign_keys=ON;
        CREATE TABLE desktop_schema_migrations(version INTEGER PRIMARY KEY,id TEXT NOT NULL UNIQUE);
        CREATE TABLE desktop_foreman_turns(request_id TEXT PRIMARY KEY);
        INSERT INTO desktop_foreman_turns VALUES('run');`)
    await initializeDesktopRound75(db)
    await initializeDesktopRound75(db)
    const execute = vi.fn(async () => ({ source: 'remote_mcp', untrusted: true, result: { content: [] } }))
    const ordinary = vi.spyOn(store, 'list')
    const identity = {engineAgentId: 'foreman', sessionId: 'chat', runId: 'run'}
    let active = true
    const bridge = serviceEngineBridge(store, service, async (run, _, action) => {
        if (run.sessionId !== identity.sessionId || run.runId !== identity.runId || (!active && action !== 'release')) throw new Error('Settled')
        return 'foreman'
    }, undefined, async () => [{name:'linear_read',description:'Read',inputSchema:{type:'object'},execute}])
    const post = (body: object) => bridge.api(new Request('http://127.0.0.1/api/desktop/internal/services', {
        method: 'POST', headers: {authorization:'Bearer fixture-engine'}, body: JSON.stringify({...identity,...body}),
    }))
    try {
        const catalog = await (await post({action:'catalog'})).json()
        const call = {action:'call',catalogId:catalog.catalogId, capabilityId:catalog.tools[0].capabilityId, toolCallId:'once',arguments:{}}
        expect(ordinary).not.toHaveBeenCalled()
        expect((await post({...call, sessionId:'other'})).status).toBe(400)
        expect((await post(call)).status).toBe(200)
        expect((await post(call)).status).toBe(400)
        active = false
        expect((await post({...call, toolCallId:'late'})).status).toBe(400)
        expect((await post({action:'release',catalogId:catalog.catalogId})).status).toBe(200)
        expect(execute).toHaveBeenCalledTimes(1)
        expect((await db.execute('SELECT * FROM desktop_foreman_service_calls')).rows).toEqual([{run_id:'run',call_id:'once'}])
        expect((await db.execute('SELECT * FROM desktop_service_calls')).rows).toEqual([])
    } finally { await bridge.shutdown(); db.close(); await rm(root, {recursive:true,force:true}) }
})

it('offers direct GitHub writes only to ordinary coworkers and keeps shared reads and dynamic wrappers visible to Chief', async () => {
    const { store, service } = await setup()
    const execute = vi.fn(async () => ({ source: 'remote_mcp', untrusted: true, result: { content: [] } }))
    const fixture = { description: 'Fixture tool', inputSchema: { type: 'object' }, execute }
    const bridge = serviceEngineBridge(store, service, async run => run.engineAgentId, undefined, async () => [
        { ...fixture, name: 'github_pull_request_read' },
        { ...fixture, name: 'github_pull_request_review_write' },
        { ...fixture, name: 'work_update', server: { name: 'work', host: 'api.githubcopilot.com', tool: 'update_pull_request' } },
        { ...fixture, name: 'COMPOSIO_MULTI_EXECUTE_TOOL' },
        { ...fixture, name: 'linear_read' },
    ])
    const post = (owner: string, body: object) => bridge.api(new Request('http://127.0.0.1/api/desktop/internal/services', {
        method: 'POST', headers: { authorization: 'Bearer fixture-engine' },
        body: JSON.stringify({ engineAgentId: owner, sessionId: 'chat', runId: 'run', ...body }),
    }))
    try {
        const chief = await (await post('foreman', { action: 'catalog' })).json()
        const coworker = await (await post('owner', { action: 'catalog' })).json()
        expect(chief.tools.map((tool: { name: string }) => tool.name)).toEqual(['github_pull_request_read', 'COMPOSIO_MULTI_EXECUTE_TOOL', 'linear_read'])
        expect(coworker.tools.map((tool: { name: string }) => tool.name)).toContain('work_update')
        const write = coworker.tools.find((tool: { name: string }) => tool.name === 'github_pull_request_review_write')
        expect(write).toBeDefined()
        const call = { action: 'call', catalogId: chief.catalogId, capabilityId: write.capabilityId, toolCallId: 'write', arguments: {} }
        expect((await post('foreman', call)).status).toBe(400)
        expect(execute).not.toHaveBeenCalled()
    } finally { await bridge.shutdown() }
})
