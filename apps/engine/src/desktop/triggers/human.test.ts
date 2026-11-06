import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createClient, type Client } from '@libsql/client'
import { randomUUID } from 'node:crypto'
import type { MessageRow } from '../../db/schema.js'
const state=vi.hoisted(()=>({client:null as Client|null,session:{id:'session',agentId:'agent',source:'trigger'},run:{id:'original',agentId:'agent',sessionId:'session',status:'done',triggerSource:'trigger',triggerSlug:'hook'},rows:[] as MessageRow[],binding:null as unknown,granted:true}))
vi.mock('../../db/systemDb.js',()=>({getSystemDb:async()=>({client:state.client!})}))
vi.mock('../../db/repos/sessions.js',()=>({getSession:async()=>state.session}))
vi.mock('../../db/repos/runs.js',()=>({getRun:async(_agent:string,id:string)=>({...state.run,id}),cancelRun:vi.fn()}))
vi.mock('../../db/repos/messages.js',()=>({listMessages:async()=>state.rows}))
vi.mock('../../agents/registry.js',()=>({getAgent:async()=>({config:{enabled:true}})}))
vi.mock('../tool-grants.js',()=>({hasDesktopToolGrant:()=>state.granted}))
vi.mock('../../runtime/run-control.js',()=>({abortRun:vi.fn(),waitForRunCancellation:async()=>true}))
vi.mock('./runtime.js',()=>({readDesktopTriggerRuntime:()=>state.binding}))
import { DESKTOP_TRIGGER_HUMAN_SQL,prepareTriggerHumanAdmission,stopTriggerHumanRequest,withoutStoppedTriggerRequests } from './human.js'
import { createDesktopTriggerStore } from './state.js'
import { desktopTriggerDefinitionRevision } from './lifecycle.js'
import { reserveDesktopQueuedTurn,getDesktopQueuedTurn } from '../../db/repos/desktop-queued-turns.js'
const definition={slug:'hook',name:'Hook',description:'',body:'Request input',enabled:true,methods:['POST'] as ['POST'],connectionId:null,provider:null,model:null,token:'token',createdAt:'now',updatedAt:'now',fireCount:0,lastFiredAt:null}
const question={sourceMessageId:'message',toolCallId:'call',fingerprint:'guard'}
const source={eventId:'event',sessionId:'session',sourceRunId:'original',sourceMessageId:'message',toolCallId:'call',kind:'question' as const}
beforeEach(async()=>{
 state.client=createClient({url:':memory:'});state.granted=true;state.session={id:'session',agentId:'agent',source:'trigger'};state.run={id:'original',agentId:'agent',sessionId:'session',status:'done',triggerSource:'trigger',triggerSlug:'hook'}
 state.rows=[{id:'message',sessionId:'session',role:'assistant',contentJson:JSON.stringify([{type:'tool-call',toolCallId:'call',toolName:'ask_user',input:{questions:[{question:'Choose',options:['Yes']}]}},{type:'tool-result',toolCallId:'call',output:{status:'delivered'}}]),toolCallsJson:null,sourcesJson:null,createdAt:'now',authorId:null,authorName:null}]
 await state.client.executeMultiple(DESKTOP_TRIGGER_HUMAN_SQL+`CREATE TABLE tool_calls(agent_id TEXT,session_id TEXT,run_id TEXT,tool_call_id TEXT,tool_name TEXT,is_error INTEGER); CREATE TABLE runs(id TEXT PRIMARY KEY,agent_id TEXT,session_id TEXT,started_at TEXT); CREATE TABLE messages(id TEXT PRIMARY KEY,session_id TEXT,role TEXT,content_json TEXT,created_at TEXT,author_id TEXT,author_name TEXT); CREATE TABLE messages_fts(content TEXT,message_id TEXT); CREATE TABLE desktop_queued_turns(run_id TEXT PRIMARY KEY,fingerprint TEXT,message_id TEXT);`)
 const store=createDesktopTriggerStore(async()=>state.client!);await store.initialize('agent')
 await store.recordEvent({eventId:'event',attemptFingerprint:null,localAgentId:'local',engineAgentId:'agent',slug:'hook',triggerName:'Hook',method:'POST',receivedAt:'now',finishedAt:null,status:'needs-input',localSessionId:'local-session',engineSessionId:'session',runId:'original',revision:desktopTriggerDefinitionRevision(definition),error:null,payloadBytes:0,truncated:false,capturedPayload:false,payloadPreview:''})
 await state.client.execute("INSERT INTO tool_calls VALUES('agent','session','original','call','ask_user',0)")
 state.binding={store,authority:{assertActive(){},resolveOwnerByEngineId:async()=>({enabled:true,deleting:false}),assertTriggerGrant:async()=>{},assertSetupClear:async()=>{},readTrigger:async()=>definition}}
})
afterEach(()=>state.client?.close())
test('the real queued batch commits lineage exactly once; original retry reads the immutable receipt',async()=>{
 const turn={runId:randomUUID(),sessionId:'session',message:'Yes',question}
 const statements=await prepareTriggerHumanAdmission('agent',turn)
 await reserveDesktopQueuedTurn('agent',turn,undefined,undefined,undefined,false,undefined,statements)
 expect(await getDesktopQueuedTurn('agent',turn)).toBe(true)
 expect((await state.client!.execute('SELECT * FROM desktop_trigger_human_admissions')).rows).toHaveLength(1)
 await expect(stopTriggerHumanRequest('agent',{source,requestId:randomUUID()})).rejects.toThrow('already admitted')
})
test('failed queue reservation rolls back lineage and message with the run',async()=>{
 const turn={runId:randomUUID(),sessionId:'session',message:'Yes',question}
 await state.client!.execute({sql:'INSERT INTO runs(id) VALUES(?)',args:[turn.runId]})
 await expect(reserveDesktopQueuedTurn('agent',turn,undefined,undefined,undefined,false,undefined,await prepareTriggerHumanAdmission('agent',turn))).rejects.toThrow()
 expect((await state.client!.execute('SELECT * FROM desktop_trigger_human_admissions')).rows).toHaveLength(0)
 expect((await state.client!.execute('SELECT * FROM messages')).rows).toHaveLength(0)
})
test('Stop of a completed human request persists, repeats exactly, and prevents any late answer after reopening',async()=>{
 const request={source,requestId:randomUUID()}
 expect(await stopTriggerHumanRequest('agent',request)).toEqual({status:'stopped'})
 expect(await stopTriggerHumanRequest('agent',request,true)).toEqual({status:'stopped'})
 expect(await stopTriggerHumanRequest('agent',request)).toEqual({status:'stopped'})
 await expect(prepareTriggerHumanAdmission('agent',{runId:randomUUID(),sessionId:'session',message:'Yes',question})).rejects.toThrow()
 await expect(stopTriggerHumanRequest('agent',{...request,requestId:randomUUID()})).rejects.toThrow('another request')
 expect(await withoutStoppedTriggerRequests('agent','session',state.rows)).toEqual([])
 expect(state.rows).toHaveLength(1)
})
test('foreign source, changed definition and removed permission refuse before any reservation',async()=>{
 await expect(stopTriggerHumanRequest('agent',{source:{...source,eventId:'foreign'},requestId:randomUUID()})).rejects.toThrow('changed')
 state.granted=false
 await expect(prepareTriggerHumanAdmission('agent',{runId:randomUUID(),sessionId:'session',message:'Yes',question})).rejects.toThrow('permission')
 state.granted=true
 await state.client!.execute("UPDATE desktop_trigger_events SET revision='changed'")
 await expect(prepareTriggerHumanAdmission('agent',{runId:randomUUID(),sessionId:'session',message:'Yes',question})).rejects.toThrow('definition')
 expect((await state.client!.execute('SELECT * FROM desktop_trigger_human_admissions')).rows).toHaveLength(0)
})
