import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { DesktopRuntime } from './runtime'
import { closeDesktopDatabase, openDesktopDatabase } from './database'
import { getDesktopRemoteMcpService, withDesktopMcpOwnerTransition, shutdownDesktopRemoteMcp } from './mcp-binding'

const context = vi.hoisted(() => ({ runtime: undefined as unknown, spawn: vi.fn() }))
vi.mock('./auth', async importOriginal => ({ ...await importOriginal<typeof import('./auth')>(), authenticateDesktopRequest: async () => context.runtime, authenticateDesktopEngineRequest: async () => context.runtime }))
vi.mock('./mcp-stdio/process', async importOriginal => ({ ...await importOriginal<typeof import('./mcp-stdio/process')>(), spawnStdio: context.spawn }))
let root: string, runtime: DesktopRuntime
let grants: Record<string, boolean>, enabled: boolean
let runStatus: string
const identity = { engineAgentId: 'engine-owner', sessionId: 'engine-chat', runId: 'run-1' }
beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'rerun-round28-')))
    runtime = { protocolVersion:1,launchNonce:randomUUID(),buildId:'fixture',workspaceId:1,dataRoot:root,app:{origin:'http://127.0.0.1:4000',sessionToken:'a'.repeat(64)},engine:{origin:'http://127.0.0.1:4001',apiKey:'b'.repeat(64)} } as DesktopRuntime
    context.runtime = runtime; context.spawn.mockReset()
    vi.stubEnv('RERUN_DESKTOP_SECRET_KEY', 'c'.repeat(64))
    grants = {}; enabled = true; runStatus = 'running'
    await mkdir(join(root,'workspaces','1','engine','agents',identity.engineAgentId,'workspace'), {recursive:true})
    const db = await openDesktopDatabase(root)
    await db.execute("INSERT INTO desktop_agents(id,workspace_id,engine_agent_id,name,created_at,updated_at) VALUES('owner',1,'engine-owner','Owner','now','now')")
    await db.execute("INSERT INTO desktop_sessions(id,agent_id,engine_session_id,title,created_at,updated_at) VALUES('chat','owner','engine-chat','Chat','now','now'),('sibling','owner','engine-sibling','Sibling','now','now')")
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        const path = new URL(url).pathname
        if (path.endsWith('/runs/run-1')) return Response.json({id:'run-1',agentId:identity.engineAgentId,sessionId:identity.sessionId,status:runStatus})
        if (path.endsWith('/sessions/engine-chat')) return Response.json({id:identity.sessionId,agentId:identity.engineAgentId})
        if (path === '/agents/engine-owner') return Response.json({id:identity.engineAgentId,config:{enabled,tools:{filesystem:true,desktopToolGrants:grants,desktopCodexGrants:{workspaceRead:true,workspaceWrite:true}}}})
        return new Response(null,{status:404})
    }))
})
afterEach(async () => { await shutdownDesktopRemoteMcp(runtime); await closeDesktopDatabase(root); await rm(root,{recursive:true,force:true}); vi.unstubAllGlobals(); vi.unstubAllEnvs() })

test('numbered migrations preserve existing roster and add independently cascading local tables across reopen', async () => {
    const db = await openDesktopDatabase(root)
    await db.execute({sql:'INSERT INTO desktop_mcp_stdio(owner,name,executable,args,revision) VALUES(?,?,?,?,?)',args:['owner','local','/usr/bin/true','[]',randomUUID()]})
    await closeDesktopDatabase(root)
    const reopened = await openDesktopDatabase(root)
    expect((await reopened.execute('SELECT id FROM desktop_schema_migrations WHERE version BETWEEN 2 AND 5 ORDER BY version')).rows.map(row => row.id)).toEqual(['native-file-review','local-mcp-programs','brain-editor-drafts','local-app-connections'])
    expect((await reopened.execute('SELECT * FROM desktop_mcp_stdio')).rows).toHaveLength(1)
    expect((await reopened.execute('SELECT * FROM desktop_sessions')).rows).toHaveLength(2)
    expect((await reopened.execute('PRAGMA foreign_key_check')).rows).toEqual([])
})

test('saved local program is inert without its separate grant and owner transition closes old admission', async () => {
    grants.mcp = true
    const service = await getDesktopRemoteMcpService(runtime)
    const request = (method:string,body?:unknown) => new Request(`${runtime.app.origin}/api/desktop/coworkers/owner/mcp-stdio`,{method,body:body?JSON.stringify(body):undefined})
    const saved = await service.localApi(request('PUT',{name:'local',executable:'/usr/bin/true',args:[]}), 'owner')
    expect(saved.status).toBe(200)
    const [connection] = await saved.json()
    expect((await service.localApi(request('POST',{name:'local',revision:connection.revision,action:'probe'}),'owner')).status).toBe(400)
    expect(context.spawn).not.toHaveBeenCalled()
    await withDesktopMcpOwnerTransition(runtime,'owner',async () => { enabled=false })
    expect((await service.localApi(request('POST',{name:'local',revision:connection.revision,action:'probe'}),'owner')).status).toBe(400)
    expect(context.spawn).not.toHaveBeenCalled()
})

test('capture needs the exact native-review opt-in and retained reviews stay in their own conversation after restart', async () => {
    const service = await getDesktopRemoteMcpService(runtime)
    const text='review only', hash=createHash('sha256').update(text).digest('hex')
    const bundle={id:randomUUID(),...identity,files:[{path:'new.md',before:null,after:text,afterHash:hash,parents:[{path:'',identity:'1:2'}]}]}
    const capture=()=>service.writebackApi.capture(new Request(`${runtime.app.origin}/api/desktop/engine/native-writeback`,{method:'POST',body:JSON.stringify(bundle)}))
    grants.privateFileWrite=true
    expect((await capture()).status).toBe(400)
    grants.nativeWriteback=true
    expect((await capture()).status).toBe(200)
    expect((await capture()).status).toBe(200)
    const review=async(sessionId:string)=> (await service.writebackApi.review(new Request(`${runtime.app.origin}/api/desktop/coworkers/owner/native-writeback?sessionId=${sessionId}`),'owner')).json()
    expect((await review('chat')).files).toHaveLength(1)
    expect((await review('sibling')).files).toHaveLength(0)
    expect((await (await openDesktopDatabase(root)).execute('SELECT * FROM desktop_native_writeback')).rows).toHaveLength(1)
    // Stop can arrive after capture committed but before its acknowledgement.
    runStatus = 'cancelled'
    const [item] = (await review('chat')).files
    expect(item.state).toBe('cancelled')
    const decision = await service.writebackApi.review(new Request(`${runtime.app.origin}/api/desktop/coworkers/owner/native-writeback`, {method:'POST',body:JSON.stringify({sessionId:'chat',proposalId:item.id,path:item.path,digest:item.digest,decision:'apply'})}), 'owner')
    expect(decision.status).toBe(400)
    expect((await (await openDesktopDatabase(root)).execute('SELECT state FROM desktop_native_writeback_files')).rows[0].state).toBe('pending')
})
