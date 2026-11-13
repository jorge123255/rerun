import { afterAll, beforeAll, afterEach, beforeEach, expect, test, vi } from 'vitest'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DesktopRuntime } from './runtime'
import { closeDesktopDatabase, openDesktopDatabase } from './database'
import { getDesktopRemoteMcpService, withDesktopMcpOwnerTransition, shutdownDesktopRemoteMcp } from './mcp-binding'
import { createDesktopSecretCrypto } from './secret-requests/crypto'
import { desktopVault } from './vault/store'

import { prepareSkillHelperFixture } from '../../../../engine/src/desktop/skill-publication.test-support'
let helper: Awaited<ReturnType<typeof prepareSkillHelperFixture>>
beforeAll(async () => { helper = await prepareSkillHelperFixture() }, 30_000)
afterAll(async () => { await helper.close() })

const context = vi.hoisted(() => ({ runtime: undefined as unknown, spawn: vi.fn() }))
let providerCalls: string[]
vi.mock('./auth', async importOriginal => ({ ...await importOriginal<typeof import('./auth')>(), authenticateDesktopRequest: async () => context.runtime, authenticateDesktopEngineRequest: async () => context.runtime }))
vi.mock('./mcp-stdio/process', async importOriginal => ({ ...await importOriginal<typeof import('./mcp-stdio/process')>(), spawnStdio: context.spawn }))
let root: string, runtime: DesktopRuntime
let grants: Record<string, boolean>, enabled: boolean
let runStatus: string
const ownerId = '11111111-1111-4111-8111-111111111111'
const identity = { engineAgentId: 'engine-owner', sessionId: 'engine-chat', runId: 'run-1' }
beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'rerun-round28-')))
    runtime = { protocolVersion:1,launchNonce:randomUUID(),buildId:'fixture',workspaceId:1,dataRoot:root,app:{origin:'http://127.0.0.1:4000',sessionToken:'a'.repeat(64)},engine:{origin:'http://127.0.0.1:4001',apiKey:'b'.repeat(64)} } as DesktopRuntime
    context.runtime = runtime; context.spawn.mockReset()
    vi.stubEnv('RERUN_DESKTOP_SECRET_KEY', 'c'.repeat(64))
    vi.stubEnv('RERUN_DESKTOP_RENAME_HELPER', helper.path)
    grants = {}; enabled = true; runStatus = 'running'; providerCalls = []
    await mkdir(join(root,'workspaces','1','engine','agents',identity.engineAgentId,'workspace'), {recursive:true})
    const db = await openDesktopDatabase(root)
    await db.execute(`INSERT INTO desktop_agents(id,workspace_id,engine_agent_id,name,created_at,updated_at) VALUES('${ownerId}',1,'engine-owner','Owner','now','now')`)
    await db.execute(`INSERT INTO desktop_sessions(id,agent_id,engine_session_id,title,created_at,updated_at) VALUES('chat','${ownerId}','engine-chat','Chat','now','now'),('sibling','${ownerId}','engine-sibling','Sibling','now','now')`)
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        if (new URL(url).hostname === 'learn.microsoft.com') {
            if (init?.method === 'DELETE') return new Response(null, {status:204})
            const body = JSON.parse(String(init?.body)); providerCalls.push(body.method)
            if (!body.id) return new Response(null, {status:202})
            return Response.json({jsonrpc:'2.0',id:body.id,result:body.method === 'initialize' ? {protocolVersion:'2025-03-26'} : body.method === 'tools/list' ? {tools:[{name:'docs_search',description:'Read documentation',inputSchema:{type:'object',properties:{query:{type:'string'}},required:['query']}}]} : {content:[{type:'text',text:'Fixture documentation result'}]}})
        }
        const path = new URL(url).pathname
        if (path.endsWith('/runs/run-1')) return Response.json({id:'run-1',agentId:identity.engineAgentId,sessionId:identity.sessionId,status:runStatus})
        if (path.endsWith('/sessions/engine-chat')) return Response.json({id:identity.sessionId,agentId:identity.engineAgentId})
        if (path === '/agents/engine-owner') return Response.json({id:identity.engineAgentId,config:{enabled,tools:{filesystem:true,desktopToolGrants:grants,desktopCodexGrants:{workspaceRead:true,workspaceWrite:true}}}})
        return new Response(null,{status:404})
    }))
})
afterEach(async () => { await shutdownDesktopRemoteMcp(runtime); await closeDesktopDatabase(root); await rm(root,{recursive:true,force:true}); vi.unstubAllGlobals(); vi.unstubAllEnvs() })


const request = (query:string,body?:unknown) => new Request(`${runtime.app.origin}/api/desktop/coworkers/${ownerId}/services${query}`,{method:body?'POST':'GET',body:body?JSON.stringify(body):undefined})
const bridgeRequest = (body:unknown) => new Request(`${runtime.app.origin}/api/desktop/internal/services`,{method:'POST',body:JSON.stringify({...identity,...body as object})})

test('the Apps Library routes fresh supported installs to the Vault and preserves existing local accounts', async () => {
    const service = await getDesktopRemoteMcpService(runtime)
    const detail = async (slug: string) => (await service.accounts.handle(request('?view=detail&slug=' + slug), ownerId)).json()
    expect(await detail('wrike')).toMatchObject({ accounts: [], vaultManaged: true })
    expect(await detail('square')).not.toHaveProperty('vaultManaged')
    expect(await detail('microsoft')).toMatchObject({ accounts: [], vaultManaged: true })

    const method = 'permanent-access-token'
    const credential = 'wrike-synthetic-library-test'
    const legacyInstall = (kind: 'new' | 'additional') => service.accounts.handle(request('', {
        action: 'install', requestId: randomUUID(), intent: { kind, slug: 'wrike' }, authMethodId: method,
        values: { WRIKE_TOKEN: credential },
    }), ownerId)
    for (const kind of ['new', 'additional'] as const) {
        const response = await legacyInstall(kind)
        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: 'This app moved to Vault. Add or choose an account there.' })
    }
    const db = await openDesktopDatabase(root)
    expect((await db.execute("SELECT id FROM desktop_service_installs WHERE slug='wrike'")).rows).toEqual([])
    const vault = desktopVault(db, createDesktopSecretCrypto(() => Buffer.from('c'.repeat(64), 'hex')), 1)
    const added = await vault.mutate({ operation: 'add-app', slug: 'wrike', methodId: method, values: { WRIKE_TOKEN: credential } }, () => {})
    expect(added.entries).toMatchObject([{ catalog: { slug: 'wrike', methodId: method }, agentIds: [], hasBearer: true }])
    expect(JSON.stringify(added)).not.toContain(credential)
    expect(await detail('wrike')).toMatchObject({ accounts: [], vaultManaged: true })

    const installed = await service.servicesApi(request('', {
        action: 'install', requestId: randomUUID(), slug: 'microsoft', authMethodId: 'default', values: {},
    }), ownerId)
    expect(installed.status).toBe(200)
    const legacy = await detail('microsoft')
    expect(legacy.accounts).toHaveLength(1)
    expect(legacy).not.toHaveProperty('vaultManaged')
    expect(providerCalls).toHaveLength(0)
})

test('real bundled catalog installs only explicitly supported methods, uses the active run and refuses stale calls', async () => {
 const service=await getDesktopRemoteMcpService(runtime)
 const detail=await (await service.servicesApi(request('?view=detail&slug=microsoft'),ownerId)).json()
 expect(detail.name).toBe('Microsoft Learn'); expect(detail.methodAvailability).toEqual([{id:'default',supported:true}])
 expect(detail.authMethods[0].label).toBe('No sign-in required')
 const catalog=await (await service.servicesApi(request('?view=catalog&limit=100'),ownerId)).json()
 expect(catalog.total).toBe(209); expect(catalog.services).toHaveLength(100)
 const install={action:'install',requestId:randomUUID(),slug:'microsoft',authMethodId:'default',values:{}}
 const installedResponse=await service.servicesApi(request('',install),ownerId); const saved=await installedResponse.json()
 expect(installedResponse.status, JSON.stringify(saved)).toBe(200)
 expect(saved.installed).toBe(false); expect(grants.services).toBeUndefined(); expect(providerCalls).toHaveLength(0)
 expect(saved.health.state).toBe('unchecked'); expect(saved.health.message).toContain('Enable Apps')
 grants.services=true
 const probed=await (await service.servicesApi(request('',{action:'probe',requestId:randomUUID(),key:saved.key,expectedRevision:saved.revision}),ownerId)).json()
 expect(probed.installed).toBe(true)
 const cap=await (await service.servicesBridge.api(bridgeRequest({action:'catalog'}))).json()
 expect(cap.tools[0].name).toBe('microsoft-learn_docs_search')
 const call={action:'call',catalogId:cap.catalogId,capabilityId:cap.tools[0].capabilityId,toolCallId:'call-1',arguments:{query:'test'}}
 const reply=await service.servicesBridge.api(bridgeRequest(call)); expect(reply.status).toBe(200)
 expect(JSON.stringify(await reply.json())).toContain('Fixture documentation result')
 expect((await service.servicesBridge.api(bridgeRequest(call))).status).toBe(400)
 expect(providerCalls.filter(x=>x==='tools/call')).toHaveLength(1)
 await withDesktopMcpOwnerTransition(runtime,ownerId,async()=>{grants.services=false})
 expect((await service.servicesBridge.api(bridgeRequest({...call,toolCallId:'call-2'}))).status).toBe(400)
 expect(providerCalls.filter(x=>x==='tools/call')).toHaveLength(1)
 const disconnected=await (await service.servicesApi(request('',{action:'disconnect',requestId:randomUUID(),key:saved.key,expectedRevision:saved.revision}),ownerId)).json()
 expect(disconnected.health.state).toBe('disconnected')
 await shutdownDesktopRemoteMcp(runtime)
 runtime={...runtime,launchNonce:randomUUID()};context.runtime=runtime
 const reopened=await getDesktopRemoteMcpService(runtime)
 const rows=await (await reopened.servicesApi(request('?view=installed'),ownerId)).json()
 expect(rows).toHaveLength(1);expect(rows[0].health.state).toBe('disconnected');expect(rows[0].installed).toBe(false)
 expect((await (await openDesktopDatabase(root)).execute('PRAGMA foreign_key_check')).rows).toEqual([])
})
