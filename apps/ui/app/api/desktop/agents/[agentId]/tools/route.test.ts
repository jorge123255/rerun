import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { agentConfigSchema, type AgentConfig } from '@rerun/contracts'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent } from '@/lib/desktop/server/store'
import { GET, PATCH } from './route'

const originalEnv = { ...process.env }
let root: string
let server: Server
let coworker: string
const agents = new Map<string, AgentConfig>()

function request(path: string, init?: { method?: string; body?: unknown }) {
    return new Request(`http://127.0.0.1:3189${path}`, {
        method: init?.method ?? 'GET',
        headers: { host: '127.0.0.1:3189', origin: 'http://127.0.0.1:3189', cookie: `rerun-desktop-session=${'r'.repeat(48)}`, 'content-type': 'application/json' },
        ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    })
}
const readTools = async (agentId: string) => {
    const response = await GET(request(`/api/desktop/agents/${agentId}/tools`), { params: Promise.resolve({ agentId }) })
    return { status: response.status, body: await response.json() }
}
const patchTools = async (agentId: string, body: unknown) => {
    const response = await PATCH(request(`/api/desktop/agents/${agentId}/tools`, { method: 'PATCH', body }), { params: Promise.resolve({ agentId }) })
    return { status: response.status, body: await response.json() }
}
type ToolRow = { id: string; enabled: boolean; available: boolean; unavailableReason?: string }
const rerunRows = (body: unknown) => (body as { rerun: ToolRow[] }).rerun

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-tools-'))
    agents.clear()
    agents.set('engine-self', agentConfigSchema.parse({ name: 'engine-self', description: 'Self tester' }))
    server = createServer(async (req, res) => {
        let text = ''
        for await (const chunk of req) text += chunk
        const body = text ? JSON.parse(text) as Record<string, unknown> : null
        const sendJson = (value: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value)) }
        const agentMatch = req.url?.match(/^\/agents\/([^/]+)$/)
        if (agentMatch && (req.method === 'GET' || req.method === 'PATCH')) {
            const config = agents.get(agentMatch[1])
            if (!config) return sendJson({ error: 'missing' }, 404)
            if (req.method === 'PATCH' && body) {
                const sent = body.tools as Record<string, unknown> | undefined
                if (sent?.desktopToolGrants) {
                    config.tools = { ...config.tools, desktopToolGrants: { ...config.tools.desktopToolGrants, ...(sent.desktopToolGrants as Record<string, boolean>) } }
                }
                if (body.selfImprovement) {
                    config.selfImprovement = { ...config.selfImprovement, ...(body.selfImprovement as Record<string, boolean>) }
                }
            }
            return sendJson({ id: agentMatch[1], config, soul: '' })
        }
        sendJson({ error: 'not found' }, 404)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No test engine address')
    Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
    await writeFile(join(root, 'runtime.json'), JSON.stringify({ protocolVersion: 1, launchNonce: 'tools', buildId: 'tools-test', workspaceId: 1, dataRoot: root,
        app: { origin: 'http://127.0.0.1:3189', sessionToken: 'r'.repeat(48) }, engine: { origin: `http://127.0.0.1:${address.port}`, apiKey: 'fixture-engine' } }), { mode: 0o600 })
    const db = await openDesktopDatabase(root)
    coworker = (await createDesktopAgent(db, { engineAgentId: 'engine-self', name: 'Self' })).id
})
afterEach(async () => {
    await closeDesktopDatabase(root)
    await new Promise<void>(resolve => server.close(() => resolve()))
    process.env = { ...originalEnv }
    await rm(root, { recursive: true, force: true })
})

test('GET reflects the master switch and keeps the nested permissions behind it', async () => {
    const { status, body } = await readTools(coworker)
    expect(status).toBe(200)
    const rows = rerunRows(body)
    expect(rows.find(row => row.id === 'self')).toMatchObject({ enabled: true, available: true })
    expect(rows.find(row => row.id === 'selfInstruction')).toMatchObject({ enabled: false, available: true })
    expect(rows.find(row => row.id === 'verbositySet')).toMatchObject({ enabled: false, available: true })
})

test('turning Improve itself off hides the permissions behind it and refuses to enable them', async () => {
    const { status, body } = await patchTools(coworker, { group: 'rerun', id: 'self', enabled: false })
    expect(status).toBe(200)
    expect(rerunRows(body).find(row => row.id === 'self')!.enabled).toBe(false)
    expect(rerunRows(body).find(row => row.id === 'selfInstruction')).toMatchObject({
        enabled: false, available: false, unavailableReason: 'Turn on Improve itself to change this permission.',
    })
    expect(rerunRows(body).find(row => row.id === 'verbositySet')!.available).toBe(false)
    const refused = await patchTools(coworker, { group: 'rerun', id: 'selfInstruction', enabled: true })
    expect(refused.status).toBe(400)
})

test('each nested permission is a separate per-coworker opt-in under the master', async () => {
    const on = await patchTools(coworker, { group: 'rerun', id: 'selfInstruction', enabled: true })
    expect(on.status).toBe(200)
    expect(rerunRows(on.body).find(row => row.id === 'selfInstruction')!.enabled).toBe(true)
    expect(rerunRows(on.body).find(row => row.id === 'verbositySet')!.enabled).toBe(false)
})

test('master and permission patches each preserve the rest of the config', async () => {
    await patchTools(coworker, { group: 'rerun', id: 'verbositySet', enabled: true })
    await patchTools(coworker, { group: 'rerun', id: 'self', enabled: false })
    const { body } = await readTools(coworker)
    expect(rerunRows(body).find(row => row.id === 'self')!.enabled).toBe(false)
    const config = agents.get('engine-self')!
    expect(config.selfImprovement.enabled).toBe(false)
    expect(config.selfImprovement.autoMemory).toBe(true)
    expect(config.tools.desktopToolGrants?.verbositySet).toBe(true)
    expect(config.description).toBe('Self tester')
})

test('shared text reading is an explicit grant and respects the shared-family pause', async () => {
    const original = await readTools(coworker)
    expect(rerunRows(original.body).find(row => row.id === 'sharedFilesRead')).toMatchObject({ enabled: false, available: true })
    const enabled = await patchTools(coworker, { group: 'rerun', id: 'sharedFilesRead', enabled: true })
    expect(enabled.status).toBe(200)
    expect(rerunRows(enabled.body).find(row => row.id === 'sharedFilesRead')).toMatchObject({ enabled: true, available: true })
    const config = agents.get('engine-self')!
    expect(config.tools.desktopToolGrants?.sharedFilesRead).toBe(true)
    expect(config.tools.desktopToolGrants?.workspaceRead).not.toBe(true)
    expect(config.tools.desktopToolGrants?.sharedDb).not.toBe(true)
    config.tools.shared = false
    expect(rerunRows((await readTools(coworker)).body).find(row => row.id === 'sharedFilesRead')).toMatchObject({ enabled: false, available: false })
    expect((await patchTools(coworker, { group: 'rerun', id: 'sharedFilesRead', enabled: true })).status).toBe(400)
    expect((await patchTools(coworker, { group: 'rerun', id: 'sharedFilesRead', enabled: false })).status).toBe(200)
})
test('routine management and reviewed installation remain separate opt-ins with their original master switch', async () => {
    const defaults = rerunRows((await readTools(coworker)).body)
    expect(defaults.find(row => row.id === 'scheduleManage')).toMatchObject({ enabled: false, available: true })
    expect(defaults.find(row => row.id === 'toolInstall')).toMatchObject({ enabled: false, available: true })
    await patchTools(coworker, { group: 'rerun', id: 'scheduleManage', enabled: true })
    expect(agents.get('engine-self')!.tools.desktopToolGrants).toMatchObject({ scheduleManage: true })
    expect(agents.get('engine-self')!.tools.desktopToolGrants?.schedule).not.toBe(true)
    agents.get('engine-self')!.selfImprovement.allowToolInstall = false
    const installed = await patchTools(coworker, { group: 'rerun', id: 'toolInstall', enabled: true })
    expect(rerunRows(installed.body).find(row => row.id === 'toolInstall')?.enabled).toBe(true)
    expect(agents.get('engine-self')!.selfImprovement.allowToolInstall).toBe(true)
    await patchTools(coworker, { group: 'rerun', id: 'self', enabled: false })
    expect((await patchTools(coworker, { group: 'rerun', id: 'toolInstall', enabled: true })).status).toBe(400)
    expect(agents.get('engine-self')!.tools.desktopToolGrants?.scheduleManage).toBe(true)
})

test('AI provider status is a separate, revocable coworker grant', async () => {
    expect(rerunRows((await readTools(coworker)).body).find(row => row.id === 'aiProviders')).toMatchObject({ enabled: false, available: true })
    const granted = await patchTools(coworker, { group: 'rerun', id: 'aiProviders', enabled: true })
    expect(granted.status).toBe(200)
    expect(rerunRows(granted.body).find(row => row.id === 'aiProviders')).toMatchObject({ enabled: true, tools: ['ai_status'] })
    expect(agents.get('engine-self')!.tools.desktopToolGrants).toEqual({ aiProviders: true })
    const revoked = await patchTools(coworker, { group: 'rerun', id: 'aiProviders', enabled: false })
    expect(revoked.status).toBe(200)
    expect(rerunRows(revoked.body).find(row => row.id === 'aiProviders')).toMatchObject({ enabled: false })
})
