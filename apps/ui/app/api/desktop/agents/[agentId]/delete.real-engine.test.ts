import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { disposableRunEngine } from '@/test/desktop-run-engine.mjs'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent, findDesktopAgent, listDesktopSessions } from '@/lib/desktop/server/store'
import { readDesktopHistory } from '@/lib/desktop/server/engine'
import { createAgent, createConnection, getAgent, setBoxDefault } from '@/lib/engine/client'
import { POST as chat } from '@/app/api/desktop/chat/route'
import { POST as duplicate } from './duplicate/route'
import { GET as roster } from '../route'
import { DELETE } from './route'

test.runIf(process.env.RERUN_RUN_HISTORY_ACCEPTANCE === '1')('deletes an idle copy permanently while its original and exact saved chat survive restart', async () => {
    const env = { ...process.env }
    const root = await mkdtemp(join(tmpdir(), 'rerun-real-delete-'))
    const fixture = await disposableRunEngine(root, undefined, { replyForRequest: (index: number) => index === 1 ? 'Original saved answer.' : 'Copy saved answer.' })
    const request = (path: string, method = 'GET', body?: unknown) => new Request(`${fixture.runtime.app.origin}${path}`, {
        method, headers: { host: new URL(fixture.runtime.app.origin).host, origin: fixture.runtime.app.origin,
            cookie: `rerun-desktop-session=${fixture.runtime.app.sessionToken}`, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const conn = () => ({ baseUrl: fixture.runtime.engine.origin, apiKey: fixture.runtime.engine.apiKey })
    const params = (agentId: string) => ({ params: Promise.resolve({ agentId }) })
    const remove = (agentId: string, confirmationName: string) => DELETE(request(`/api/desktop/agents/${agentId}`, 'DELETE', { confirmationName }), params(agentId))
    try {
        await fixture.start()
        Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
        const provider = await createConnection(conn(), { name: 'Local deletion fixture', provider: 'openrouter', models: ['qa-local'], extraModels: [], baseUrl: fixture.providerOrigin, keys: { OPENROUTER_API_KEY: 'fixture-only' } })
        await setBoxDefault(conn(), { connectionId: provider.id, model: 'qa-local' })
        const source = await createAgent(conn(), { config: { name: 'original', displayName: 'Original', enabled: true, connectionId: provider.id, provider: 'openrouter', selfImprovement: { enabled: false, autoMemory: false } } })
        let db = await openDesktopDatabase(root)
        const original = await createDesktopAgent(db, { name: 'Original', engineAgentId: source.id })
        const first = await chat(request('/api/desktop/chat', 'POST', { agentId: original.id, text: 'Remember the original chat. Do not use tools.' }))
        expect(first.status).toBe(200)
        const originalSessionId = first.headers.get('x-session-id')!
        const firstStream = first.text()
        await fixture.waitForProviderRequest(1)
        fixture.finishReply()
        expect(await firstStream).toContain('Original saved answer.')
        let originalHistory: Awaited<ReturnType<typeof readDesktopHistory>> = []
        await vi.waitFor(async () => {
            originalHistory = await readDesktopHistory(fixture.runtime, originalSessionId)
            expect(JSON.stringify(originalHistory)).toContain('Original saved answer.')
        })
        const originalSessions = await listDesktopSessions(db, original.id)
        const requestId = crypto.randomUUID()
        const placement = { requestId, position: { col: 1, row: 1 } }
        const duplicated = await duplicate(request(`/api/desktop/agents/${original.id}/duplicate`, 'POST', placement), params(original.id))
        expect(duplicated.status).toBe(201)
        const { agent: copied } = await duplicated.json()
        const copy = (await findDesktopAgent(db, copied.id))!
        expect(copy.engineAgentId).not.toBe(original.engineAgentId)
        expect(await listDesktopSessions(db, copy.id)).toEqual([])
        const second = await chat(request('/api/desktop/chat', 'POST', { agentId: copy.id, text: 'Remember the independent copy chat. Do not use tools.' }))
        expect(second.status).toBe(200)
        const copySessionId = second.headers.get('x-session-id')!
        const secondStream = second.text()
        await fixture.waitForProviderRequest(2)
        expect((await remove(copy.id, copy.name)).status).toBe(409)
        expect(await findDesktopAgent(db, copy.id)).not.toBeNull()
        expect((await getAgent(conn(), copy.engineAgentId)).id).toBe(copy.engineAgentId)
        fixture.finishReply()
        expect(await secondStream).toContain('Copy saved answer.')
        await vi.waitFor(async () => expect(JSON.stringify(await readDesktopHistory(fixture.runtime, copySessionId))).toContain('Copy saved answer.'))
        await vi.waitFor(async () => expect((await remove(copy.id, copy.name)).status).toBe(200))
        expect(await findDesktopAgent(db, copy.id)).toBeNull()
        expect(await listDesktopSessions(db, copy.id)).toEqual([])
        const copyRoot = join(root, 'workspaces/1/engine/agents', copy.engineAgentId)
        expect(existsSync(copyRoot)).toBe(false)
        expect(await listDesktopSessions(db, original.id)).toEqual(originalSessions)
        expect(await readDesktopHistory(fixture.runtime, originalSessionId)).toEqual(originalHistory)
        await closeDesktopDatabase(root)
        await fixture.stop()
        await fixture.start()
        db = await openDesktopDatabase(root)
        const response = await roster(request('/api/desktop/agents'))
        expect((await response.json()).agents.map((row: { id: string }) => row.id)).toEqual([original.id])
        expect((await getAgent(conn(), original.engineAgentId)).id).toBe(original.engineAgentId)
        expect(await listDesktopSessions(db, original.id)).toEqual(originalSessions)
        expect(await readDesktopHistory(fixture.runtime, originalSessionId)).toEqual(originalHistory)
        expect(existsSync(copyRoot)).toBe(false)
        expect((await duplicate(request(`/api/desktop/agents/${original.id}/duplicate`, 'POST', placement), params(original.id))).status).toBe(404)
        expect((await remove(copy.id, copy.name)).status).toBe(200)
        expect(existsSync(copyRoot)).toBe(false)
        expect(fixture.providerMessages).toHaveLength(2)
    } finally {
        await closeDesktopDatabase(root)
        await fixture.close()
        process.env = env
        await rm(root, { recursive: true, force: true })
    }
}, 60000)
