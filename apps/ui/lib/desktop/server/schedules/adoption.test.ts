import {createClient} from '@libsql/client'
import {afterEach,describe,expect,it,vi} from 'vitest'
vi.mock('server-only',()=>({}))
const engine=vi.hoisted(()=>({owner:'engine-a',source:'schedule',runSession:'session-a',sessionId:'session-a',runId:'run-a',runSource:'schedule'}))
vi.mock('@/lib/engine/client',()=>({getSession:async()=>({id:engine.sessionId,agentId:engine.owner,source:engine.source,title:'Daily report',createdAt:'2026-11-01T00:00:00Z'}),getRun:async()=>({id:engine.runId,agentId:engine.owner,sessionId:engine.runSession,triggerSource:engine.runSource})}))
vi.mock('../store',()=>({findDesktopAgent:async()=>({id:'local-a',engineAgentId:'engine-a'}),sessionOf:(row:Record<string,unknown>)=>({id:row.id,agentId:row.agent_id,title:row.title})}))
import {adoptDesktopScheduledSession} from './adoption'
const clients:ReturnType<typeof createClient>[]=[]
afterEach(()=>{for(const db of clients.splice(0))db.close();engine.owner='engine-a';engine.source='schedule';engine.runSession='session-a';engine.sessionId='session-a';engine.runId='run-a';engine.runSource='schedule'})
async function database(){const db=createClient({url:'file::memory:'});clients.push(db);await db.executeMultiple(`CREATE TABLE desktop_agents(id TEXT,engine_agent_id TEXT,workspace_id INTEGER);INSERT INTO desktop_agents VALUES('local-a','engine-a',1);CREATE TABLE desktop_deletions(agent_id TEXT);CREATE TABLE desktop_sessions(id TEXT,agent_id TEXT,engine_session_id TEXT UNIQUE,title TEXT,created_at TEXT,updated_at TEXT);`);return db}
const input={agentId:'local-a',engineAgentId:'engine-a',engineSessionId:'session-a',runId:'run-a'}
describe('durable scheduled chat adoption',()=>{
    it('returns the same local conversation and tab identity on replay',async()=>{const db=await database();const first=await adoptDesktopScheduledSession(db,{baseUrl:'http://127.0.0.1:1',apiKey:'example'},input);const replay=await adoptDesktopScheduledSession(db,{baseUrl:'http://127.0.0.1:1',apiKey:'example'},input);expect(replay.sessionId).toBe(first.sessionId);expect(replay.tabUid).toBe(first.tabUid);expect((await db.execute('SELECT * FROM desktop_sessions')).rows).toHaveLength(1)})
    it('rejects foreign engine ownership and unrelated runs',async()=>{const db=await database();engine.owner='engine-b';await expect(adoptDesktopScheduledSession(db,{baseUrl:'http://127.0.0.1:1',apiKey:'example'},input)).rejects.toThrow();engine.owner='engine-a';engine.runSession='other';await expect(adoptDesktopScheduledSession(db,{baseUrl:'http://127.0.0.1:1',apiKey:'example'},input)).rejects.toThrow();expect((await db.execute('SELECT * FROM desktop_sessions')).rows).toHaveLength(0)})
    it('rejects substituted session IDs, run IDs and non-schedule runs before persistence',async()=>{
        const db=await database(), connection={baseUrl:'http://127.0.0.1:1',apiKey:'example'}
        engine.sessionId='other'
        await expect(adoptDesktopScheduledSession(db,connection,input)).rejects.toThrow()
        engine.sessionId='session-a';engine.runId='other'
        await expect(adoptDesktopScheduledSession(db,connection,input)).rejects.toThrow()
        engine.runId='run-a';engine.runSource='chat'
        await expect(adoptDesktopScheduledSession(db,connection,input)).rejects.toThrow()
        expect((await db.execute('SELECT * FROM desktop_sessions')).rows).toHaveLength(0)
    })
    it('cannot adopt a session after coworker deletion begins',async()=>{const db=await database();await db.execute("INSERT INTO desktop_deletions VALUES('local-a')");await expect(adoptDesktopScheduledSession(db,{baseUrl:'http://127.0.0.1:1',apiKey:'example'},input)).rejects.toThrow()})
})
