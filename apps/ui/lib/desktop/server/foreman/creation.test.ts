import { createClient, type Client } from '@libsql/client'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { DESKTOP_TEMPLATE_LIMITS, DESKTOP_TEMPLATE_PROSE_WARNING } from '@rerun/contracts'
import type { DesktopRuntime } from '../runtime'
import { initializeDesktopTemplates } from '../templates/schema'
import { initializeDesktopCreation } from '../new-agent-schema'
import { ensureDesktopSetupSchema } from '../setup/schema'
import { initializeDesktopSpaces, readDesktopBoardState, writeDesktopBoardState } from '../spaces'
import { createForemanRuntime } from './runtime'
import { createForemanSqliteStore, DESKTOP_FOREMAN_SCHEMA_STATEMENTS } from './store'
import { createDesktopForemanCreationAuthority, DESKTOP_FOREMAN_CREATION_SCHEMA_SQL } from './creation'

type EngineAgent = {id:string;config:{name:string;displayName?:string;description?:string;enabled:boolean;connectionId:string|null;provider?:string;model:string|null;setup:{required:boolean|null;completedAt:null;sessionId:string|null}};soul:string;install:string;revision:number}
const state = vi.hoisted(() => ({db:null as unknown as Client,runtime:null as unknown as DesktopRuntime,agents:new Map<string,EngineAgent>(),creations:new Map<string,{config:EngineAgent['config'];instructions:{soulMd:string;installMd:string}}>(),mutations:new Map<string,{fingerprint:string;result:unknown}>(),runs:new Map<string,unknown>(),posts:[] as {path:string;body:Record<string,unknown>}[],loseCreateAck:false,templateReceipts:new Map<string,Record<string,unknown>>() }))
vi.mock('../runtime', () => ({readDesktopRuntime:async()=>state.runtime}))
vi.mock('../database', () => ({openDesktopDatabase:async()=>state.db}))
vi.mock('../settings', () => ({engineOf:(runtime:DesktopRuntime)=>({baseUrl:runtime.engine.origin,apiKey:runtime.engine.apiKey}),readDesktopProviders:async()=>({connections:[{id:'codex-test',name:'Codex',provider:'codex',connected:true,models:['terra'],extraModels:[]}],default:null})}))
vi.mock('../engine',()=>({startDesktopChat:async(_runtime:unknown,input:{agentId:string;sessionId:string;requestId:string;text:string})=>{state.runs.set(input.requestId,input);return {sessionId:input.sessionId,response:new Response('',{headers:{'x-run-id':input.requestId}})}}}))
vi.mock('@/lib/engine/client',()=>({
    EngineRequestError:class extends Error {constructor(message:string,readonly status:number){super(message)}},
    getAgent:async(_engine:unknown,id:string)=>{const value=state.agents.get(id);if(!value)throw new Error('missing');return structuredClone(value)},
    patchAgent:async(_engine:unknown,id:string,patch:{enabled:boolean})=>{const value=state.agents.get(id)!;value.config.enabled=patch.enabled;return structuredClone(value)},
    getSessionMessages:async()=>[],
    request:async<T>(_engine:unknown,path:string,init:RequestInit,parse:(value:unknown)=>T)=>parse(await dispatch(path,init)),
}))
const templateId='a'.repeat(32), revision='b'.repeat(64)
const detail={templateId,revision,title:'Notes',capturedAt:'2026-11-05T12:00:00.000Z',proseWarning:DESKTOP_TEMPLATE_PROSE_WARNING,limits:DESKTOP_TEMPLATE_LIMITS,engineCommit:null,coworkers:[{agentKey:'c00',name:'Template helper',description:'Organizes notes',setup:{required:true,prompt:'Connect your notes.',answered:true},files:[],exclusions:[],redactions:[],strippedConfigKeys:[],envKeys:[],mcpAuth:[]}]}
function setupOf(agent:EngineAgent){return {required:agent.config.setup.required,prompt:agent.install,completedAt:agent.config.setup.completedAt,sessionId:agent.config.setup.sessionId,pending:agent.config.setup.required===true&&!!agent.install,revision:String(agent.revision)}}
async function dispatch(path:string,init:RequestInit):Promise<unknown>{
    const body=init.body?JSON.parse(String(init.body)) as Record<string,unknown>:{}
    if(init.method==='POST')state.posts.push({path,body})
    if(path==='/desktop/agents/foreman-create'){
        const value=body as unknown as {requestId:string;config:EngineAgent['config'];instructions:{soulMd:string;installMd:string}},id=`new-${value.requestId}`
        const previous=state.creations.get(value.requestId)
        if(previous && JSON.stringify(previous)!==JSON.stringify({config:value.config,instructions:value.instructions}))throw new Error('conflict')
        if(!previous){
            state.creations.set(value.requestId,structuredClone({config:value.config,instructions:value.instructions}))
            state.agents.set(id,{id,config:{...value.config,setup:{required:true,completedAt:null,sessionId:null}},soul:value.instructions.soulMd,install:value.instructions.installMd,revision:0})
        }
        if(state.loseCreateAck){state.loseCreateAck=false;throw new Error('lost engine acknowledgement')}
        return structuredClone(state.agents.get(id))
    }
    if(path.startsWith('/desktop/agents/foreman-create/')){
        const id=path.split('/').at(-1)!,receipt=state.creations.get(id)
        return receipt?{state:'present',id:`new-${id}`,input:receipt.config,instructions:receipt.instructions}:{state:'absent'}
    }
    if(path.startsWith(`/desktop/templates/${templateId}`))return detail
    if(path==='/desktop/templates/install'){
        const entries=body.coworkers as {engineAgentId:string;agentKey:string}[]
        for(const entry of entries){
            if(!state.agents.has(entry.engineAgentId))state.agents.set(entry.engineAgentId,{id:entry.engineAgentId,config:{name:'Template helper',enabled:body.foremanDisabled!==true,connectionId:null,model:null,setup:{required:null,completedAt:null,sessionId:null}},soul:'Template soul',install:'Connect your notes.',revision:0})
            state.templateReceipts.set(entry.engineAgentId,{state:'present',engineAgentId:entry.engineAgentId,importReceiptId:body.importReceiptId,templateId:body.templateId,revision:body.revision})
        }
        return {status:'ready',coworkers:entries.map(entry=>({...entry,name:'Template helper',description:'Organizes notes',phase:'indexed'}))}
    }
    if(path.startsWith('/desktop/templates/foreman-import/'))return state.templateReceipts.get(path.split('/')[4]!)??{state:'absent'}
    const match=/^\/agents\/([^/]+)\/setup(?:\/(save|claim|import))?$/.exec(path)
    if(match){
        const agent=state.agents.get(match[1]!)!;if(!agent)throw new Error('missing setup owner')
        const action=match[2]
        if(!action)return setupOf(agent)
        const key=`${path}:${String(body.requestId??body.importReceiptId)}`,fingerprint=JSON.stringify(body),prior=state.mutations.get(key)
        if(prior){if(prior.fingerprint!==fingerprint)throw new Error('changed setup mutation');return prior.result}
        if(action==='import'){agent.install=String(body.prompt);agent.config.setup.required=body.required===true;agent.revision++}
        else {
            if(String(body.expectedRevision)!==String(agent.revision))throw new Error('stale setup revision')
            if(action==='save'){agent.install=String(body.prompt);agent.config.setup.required=body.required===true}
            if(action==='claim'){if(!agent.config.enabled)throw new Error('disabled');agent.config.setup.sessionId??=randomUUID()}
            agent.revision++
        }
        const result=action==='claim'?{sessionId:agent.config.setup.sessionId}:setupOf(agent)
        state.mutations.set(key,{fingerprint,result});return result
    }
    throw new Error(`Unexpected engine boundary ${path}`)
}
let root:string,db:Client
beforeEach(async()=>{
    root=await mkdtemp(join(tmpdir(),'rerun-foreman-authority-'));db=createClient({url:`file:${join(root,'app.db')}`});state.db=db
    state.runtime={protocolVersion:1,workspaceId:1,launchNonce:'launch',buildId:'build',dataRoot:root,app:{origin:'http://127.0.0.1:3000',sessionToken:'a'.repeat(32)},engine:{origin:'http://127.0.0.1:3001',apiKey:'test'}}
    state.agents.clear();state.creations.clear();state.mutations.clear();state.runs.clear();state.templateReceipts.clear();state.posts=[];state.loseCreateAck=false
    await db.executeMultiple(`PRAGMA foreign_keys=ON;
      CREATE TABLE desktop_workspace(id INTEGER PRIMARY KEY,name TEXT);INSERT INTO desktop_workspace VALUES(1,'My team');
      CREATE TABLE desktop_agents(id TEXT PRIMARY KEY,workspace_id INTEGER,engine_agent_id TEXT UNIQUE,name TEXT,description TEXT,enabled INTEGER DEFAULT 1,created_at TEXT,updated_at TEXT);
      CREATE TABLE desktop_duplicates(request_id TEXT PRIMARY KEY,source_id TEXT,agent_id TEXT,name TEXT,handle TEXT,board_col INTEGER,board_row INTEGER,completed INTEGER DEFAULT 0,space_id TEXT);
      CREATE TABLE desktop_deletions(agent_id TEXT PRIMARY KEY,engine_agent_id TEXT,name TEXT,completed INTEGER DEFAULT 0);
      CREATE TABLE desktop_sessions(id TEXT PRIMARY KEY,agent_id TEXT,engine_session_id TEXT UNIQUE,title TEXT,created_at TEXT,updated_at TEXT,model_connection_id TEXT,model TEXT);
    `)
    await initializeDesktopCreation(db);await initializeDesktopSpaces(db);await initializeDesktopTemplates(db);await ensureDesktopSetupSchema(db);await db.executeMultiple(DESKTOP_FOREMAN_CREATION_SCHEMA_SQL + DESKTOP_FOREMAN_SCHEMA_STATEMENTS.map(sql=>`${sql};`).join('\n'))
})
afterEach(async()=>{db.close();await rm(root,{recursive:true,force:true})})
const bind=()=>createDesktopForemanCreationAuthority(state.runtime,db)
async function spec(){return {requestId:randomUUID(),spaceId:(await readDesktopBoardState(db)).spaces[0]!.id,name:'Researcher',description:'Finds answers',soulMd:'# Role\nExact instructions.\n',installMd:'# Setup\nAsk about the real task.\n',model:{connectionId:'codex-test',model:'terra'}}}
async function reopen(){db.close();db=createClient({url:`file:${join(root,'app.db')}`});state.db=db;return bind()}

test('exact concurrent creation persists one disabled coworker, instruction bytes and pinned model without chat',async()=>{
    const a=await bind(),b=await bind(),input=await spec()
    const [one,two]=await Promise.all([a.creation.createCoworker(input),b.creation.createCoworker(input)])
    expect(one).toEqual(two);expect((await db.execute('SELECT id,enabled FROM desktop_agents')).rows).toEqual([{id:one.agentId,enabled:0}])
    expect(state.creations.size).toBe(1);expect(state.runs.size).toBe(0)
    expect(state.agents.get(`new-${input.requestId}`)).toMatchObject({soul:input.soulMd,install:input.installMd,config:{enabled:false,connectionId:'codex-test',model:'terra',setup:{required:true,sessionId:null}}})
    const restarted=await reopen()
    expect(await restarted.creation.createCoworker(input)).toEqual(one)
    expect(await restarted.creation.lookupCoworker(input.requestId)).toEqual({state:'present',value:{agentId:one.agentId,spaceId:input.spaceId}})
    await expect(restarted.creation.createCoworker({...input,soulMd:'Changed'})).rejects.toMatchObject({status:409})
    expect(state.creations.size).toBe(1)
})

test('lost engine acknowledgement recovers only the same reserved coworker on explicit retry',async()=>{
    const a=await bind(),input=await spec();state.loseCreateAck=true
    await expect(a.creation.createCoworker(input)).rejects.toThrow('lost engine')
    expect(state.creations.size).toBe(1);expect((await db.execute('SELECT id FROM desktop_agents')).rows).toHaveLength(0)
    const restarted=await reopen()
    expect(await restarted.creation.lookupCoworker(input.requestId)).toEqual({state:'unknown'})
    await restarted.creation.resumePending!(input.requestId)
    const receipt=await restarted.creation.lookupCoworker(input.requestId)
    expect(receipt.state).toBe('present');if(receipt.state!=='present')throw new Error('missing recovered receipt')
    const one=receipt.value
    expect(state.creations.size).toBe(1);expect((await db.execute('SELECT id FROM desktop_agents')).rows).toEqual([{id:one.agentId}])
})

test('exact Box receipt survives restart and refuses a same-name replacement',async()=>{
    const a=await bind(),input={requestId:randomUUID(),name:'Research',order:0}
    const one=await a.creation.ensureBox(input);const restarted=await reopen()
    expect(await restarted.creation.ensureBox(input)).toEqual(one)
    await db.execute({sql:'DELETE FROM desktop_spaces WHERE id=?',args:[one.spaceId]})
    await writeDesktopBoardState(db,{requestId:randomUUID(),expectedRevision:(await readDesktopBoardState(db)).revision,command:{kind:'create',name:input.name}})
    expect(await restarted.creation.lookupBox(input.requestId)).toEqual({state:'replaced'})
    await expect(restarted.creation.ensureBox(input)).rejects.toThrow('removed')
})

test('Box transaction hook failure rolls back its Board effect and canonical request receipt',async()=>{
    const before=await readDesktopBoardState(db),requestId=randomUUID()
    await expect(writeDesktopBoardState(db,{requestId,expectedRevision:before.revision,command:{kind:'create',name:'Atomic'}},async tx=>{
        await tx.execute({sql:"INSERT INTO desktop_foreman_creation_receipts VALUES(?,'box','x','{}','complete','{}','{}','now')",args:[requestId]})
        throw new Error('interrupted commit')
    })).rejects.toThrow('interrupted commit')
    expect(await readDesktopBoardState(db)).toEqual(before)
    expect((await db.execute('SELECT request_id FROM desktop_space_writes')).rows).toHaveLength(0)
    expect((await db.execute('SELECT request_id FROM desktop_foreman_creation_receipts')).rows).toHaveLength(0)
})

test('explicit lead setup enables only its exact coworker, starts once and restores its session after restart',async()=>{
    const a=await bind(),first=await spec(),second={...await spec(),name:'Sibling'}
    const lead=await a.creation.createCoworker(first),sibling=await a.creation.createCoworker(second),input={requestId:randomUUID(),agentId:lead.agentId}
    expect(state.runs.size).toBe(0)
    const one=await a.setup.startSetup(input)
    expect(state.runs.size).toBe(1)
    expect(state.agents.get(`new-${first.requestId}`)?.config.enabled).toBe(true)
    expect(state.agents.get(`new-${second.requestId}`)?.config.enabled).toBe(false)
    const restarted=await reopen()
    expect(await restarted.setup.startSetup(input)).toEqual(one)
    expect(await restarted.setup.lookupSetup(input.requestId)).toEqual({state:'present',value:one})
    await expect(restarted.setup.startSetup({...input,agentId:sibling.agentId})).rejects.toMatchObject({status:409})
    expect(state.runs.size).toBe(1)
})

test('Foreman template reservations are separate from UI attempts and install disabled with original focus before explicit setup',async()=>{
    const a=await bind(),spaceId=(await readDesktopBoardState(db)).spaces[0]!.id,input={requestId:randomUUID(),templateId,spaceId,focus:'Get the real notes organized'}
    const one=await a.creation.installTemplate(input)
    expect(one.agentIds).toHaveLength(1);expect(state.runs.size).toBe(0)
    const engine=[...state.agents.values()][0]!
    expect(engine.config.enabled).toBe(false);expect(engine.config.setup.required).toBe(true)
    expect(engine.install).toContain('Get the real notes organized');expect(engine.install).toContain('Connect your notes.')
    const restarted=await reopen();expect(await restarted.creation.installTemplate(input)).toEqual(one)
    expect((await db.execute('SELECT state FROM desktop_foreman_creation_receipts')).rows).toEqual([{state:'complete'}])
    await expect(restarted.creation.installTemplate({...input,focus:'Different'})).rejects.toMatchObject({status:409})
    expect(state.posts.filter(item=>item.path==='/desktop/templates/install')).toHaveLength(1)
})

test('deleted coworker receipts never create another coworker and a replaced workspace has no effects',async()=>{
    const a=await bind(),input=await spec(),one=await a.creation.createCoworker(input)
    await db.execute({sql:'DELETE FROM desktop_space_placements WHERE agent_id=?',args:[one.agentId]});await db.execute({sql:'DELETE FROM desktop_agents WHERE id=?',args:[one.agentId]})
    expect(await a.creation.lookupCoworker(input.requestId)).toEqual({state:'replaced'})
    await expect(a.creation.createCoworker(input)).rejects.toMatchObject({status:409})
    state.runtime={...state.runtime,launchNonce:'changed'}
    await expect(a.creation.createCoworker(await spec())).rejects.toMatchObject({failure:'workspace_changed'})
    expect(state.creations.size).toBe(1)
})


test('real SQLite build recovery never replays during startup, then explicit Resume publishes the same partially created coworker',async()=>{
    const chat={workspaceId:'1',chatId:`fmc_${randomUUID()}`},binding={...chat,runId:randomUUID(),model:{connectionId:'codex-test',model:'terra'}}
    async function core(){
        const authority=await bind()
        return createForemanRuntime({store:createForemanSqliteStore(db),companyName:async()=> 'Local team',authorities:{
            ...authority,workspace:{currentWorkspaceId:async()=> '1',agentCount:async()=>Number((await db.execute('SELECT count(*) AS n FROM desktop_agents')).rows[0]!.n)},
            run:{isLive:async()=>true,currentLive:async()=>({runId:binding.runId,model:binding.model}),isObserved:async()=>true,modelAvailable:async()=>true,sendFollowUp:async()=>{throw new Error('unexpected followup')},lookupFollowUp:async()=>({state:'absent'})},events:{publish:()=>{}},collectDiscovery:null,
        }})
    }
    const first=await core(),shown=await first.recordShownPlan(binding,'show-local-team',{title:'A careful researcher',boxes:[{name:'Research'}],items:[{kind:'agent',name:'Researcher',role:'Finds useful sources',box:'Research'}]})
    state.loseCreateAck=true
    const decision=await first.decide({decision:'confirm',requestId:randomUUID(),chat,planId:shown.revision.planId,revisionId:shown.revision.revisionId,digest:shown.revision.digest})
    await first.runBuild(decision.buildId!)
    expect((await first.readView(chat)).build?.state).toBe('uncertain')
    expect(state.creations.size).toBe(1)
    const reserved=String((await db.execute("SELECT request_id FROM desktop_foreman_creation_receipts WHERE kind='coworker'")).rows[0]!.request_id)
    await reopen();const restarted=await core(),before=state.posts.length
    await restarted.reconcile();await restarted.readView(chat)
    expect(state.posts).toHaveLength(before)
    await restarted.buildAction({action:'resume',requestId:randomUUID(),chat,buildId:decision.buildId!})
    await restarted.runBuild(decision.buildId!)
    expect((await restarted.readView(chat)).build?.state).toBe('completed')
    expect(state.creations.size).toBe(1)
    expect(state.posts.filter(item=>item.path==='/desktop/agents/foreman-create').map(item=>item.body.requestId)).toEqual([reserved,reserved])
    expect((await db.execute('SELECT enabled FROM desktop_agents')).rows).toEqual([{enabled:0}])
    expect(state.runs.size).toBe(0)
})


test('a full Box is a definite creation refusal before any engine dispatch',async()=>{
    const a=await bind(),input=await spec()
    await db.execute({sql:'UPDATE desktop_spaces SET col_end=col_start+3,row_end=row_start+3 WHERE id=?',args:[input.spaceId]})
    const originals=[]
    for(let i=0;i<4;i++) originals.push(await a.creation.createCoworker({...input,requestId:randomUUID()}))
    await expect(a.creation.createCoworker({...input,requestId:randomUUID()})).rejects.toMatchObject({failure:'creation_failed',message:expect.stringContaining('no room')})
    expect(state.creations.size).toBe(4)
    expect((await db.execute('SELECT id FROM desktop_agents')).rows).toEqual(expect.arrayContaining(originals.map(item=>({id:item.agentId}))))
})

test('a lost engine ACK stays uncertain when its Box fills, then recovers the exact saved coworker after space is freed',async()=>{
    const space=(await readDesktopBoardState(db)).spaces[0]!
    await db.execute({sql:'UPDATE desktop_spaces SET col_end=col_start+3,row_end=row_start+3 WHERE id=?',args:[space.id]})
    const chat={workspaceId:'1',chatId:`fmc_${randomUUID()}`},binding={...chat,runId:randomUUID(),model:{connectionId:'codex-test',model:'terra'}}
    async function core(){
        const authority=await bind()
        return createForemanRuntime({store:createForemanSqliteStore(db),companyName:async()=> 'Local team',authorities:{
            ...authority,workspace:{currentWorkspaceId:async()=> '1',agentCount:async()=>Number((await db.execute('SELECT count(*) AS n FROM desktop_agents')).rows[0]!.n)},
            run:{isLive:async()=>true,currentLive:async()=>({runId:binding.runId,model:binding.model}),isObserved:async()=>true,modelAvailable:async()=>true,sendFollowUp:async()=>{throw new Error('unexpected followup')},lookupFollowUp:async()=>({state:'absent'})},events:{publish:()=>{}},collectDiscovery:null,
        }})
    }
    const first=await core(),shown=await first.recordShownPlan(binding,'lost-ack-full-box',{title:'Recover this researcher',boxes:[{name:space.name}],items:[{kind:'agent',name:'Researcher',role:'Finds useful sources',box:space.name}]})
    state.loseCreateAck=true
    const decision=await first.decide({decision:'confirm',requestId:randomUUID(),chat,planId:shown.revision.planId,revisionId:shown.revision.revisionId,digest:shown.revision.digest})
    await first.runBuild(decision.buildId!)
    expect((await first.readView(chat)).build?.state).toBe('uncertain')
    const saved=(await db.execute("SELECT request_id,payload FROM desktop_foreman_creation_receipts WHERE kind='coworker'")).rows[0]!
    const requestId=String(saved.request_id),payload=JSON.parse(String(saved.payload)) as {agentId:string;engineAgentId:string;input:unknown}
    expect(payload.engineAgentId).toBe(`new-${requestId}`)
    expect(state.agents.has(payload.engineAgentId)).toBe(true)
    expect((await db.execute('SELECT id FROM desktop_agents')).rows).toHaveLength(0)
    const authority=await bind()
    for(let i=0;i<4;i++) await authority.creation.createCoworker({...await spec(),name:`Other coworker ${i}`})
    const enginePosts=state.posts.filter(item=>item.path==='/desktop/agents/foreman-create').length

    await reopen()
    const restarted=await core(),resume={action:'resume' as const,requestId:randomUUID(),chat,buildId:decision.buildId!}
    await restarted.reconcile()
    await expect(restarted.buildAction(resume)).rejects.toMatchObject({code:'uncertain'})
    const blocked=(await restarted.readView(chat)).build!
    expect(blocked.state).toBe('uncertain')
    expect(blocked.items[0]).toMatchObject({state:'uncertain',created:null,failure:null})
    expect(await (await bind()).creation.lookupCoworker(requestId)).toEqual({state:'unknown'})
    expect((await db.execute({sql:'SELECT state,payload FROM desktop_foreman_creation_receipts WHERE request_id=?',args:[requestId]})).rows[0]).toEqual({state:'pending',payload:saved.payload})
    expect(state.posts.filter(item=>item.path==='/desktop/agents/foreman-create')).toHaveLength(enginePosts)
    expect(state.creations.size).toBe(5)

    // Expanding the same Box makes the original immutable request admissible again.
    await db.execute({sql:'UPDATE desktop_spaces SET col_end=col_start+5 WHERE id=?',args:[space.id]})
    await restarted.buildAction(resume)
    await restarted.runBuild(decision.buildId!)
    expect((await restarted.readView(chat)).build).toMatchObject({state:'completed',items:[{state:'created',created:{agentIds:[payload.agentId],spaceId:space.id}}]})
    expect((await db.execute({sql:'SELECT id,engine_agent_id,enabled FROM desktop_agents WHERE id=?',args:[payload.agentId]})).rows).toEqual([{id:payload.agentId,engine_agent_id:payload.engineAgentId,enabled:0}])
    expect(state.posts.filter(item=>item.path==='/desktop/agents/foreman-create'&&item.body.requestId===requestId).map(item=>item.body)).toEqual([payload.input,payload.input])
    expect(state.creations.size).toBe(5)
    expect(state.runs.size).toBe(0)
})
