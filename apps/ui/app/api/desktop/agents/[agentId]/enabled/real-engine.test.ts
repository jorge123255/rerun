import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { disposableRunEngine } from '@/test/desktop-run-engine.mjs'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent, listDesktopSessions } from '@/lib/desktop/server/store'
import { readDesktopHistory } from '@/lib/desktop/server/engine'
import { createAgent, createConnection, getAgent, setBoxDefault, chat as engineChat } from '@/lib/engine/client'
import { POST as chat } from '@/app/api/desktop/chat/route'
import { GET as roster } from '../../route'
import { PATCH } from './route'

test.runIf(process.env.RERUN_RUN_HISTORY_ACCEPTANCE === '1')('disabled coworkers retain chats, allow an already-running reply to finish, and resume the same chat after restart', async () => {
    const originalEnv = { ...process.env }
    const root = await mkdtemp(join(tmpdir(), 'rerun-real-enabled-'))
    const fixture = await disposableRunEngine(root)
    const request = (path: string, method = 'GET', body?: unknown) => new Request(`${fixture.runtime.app.origin}${path}`, {
        method, headers: { host: new URL(fixture.runtime.app.origin).host, origin: fixture.runtime.app.origin,
            cookie: `rerun-desktop-session=${fixture.runtime.app.sessionToken}`, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const connection = () => ({ baseUrl: fixture.runtime.engine.origin, apiKey: fixture.runtime.engine.apiKey })
    const toggle = (id: string, enabled: boolean) => PATCH(request(`/api/desktop/agents/${id}/enabled`, 'PATCH', { enabled }), { params: Promise.resolve({ agentId: id }) })
    try {
        await fixture.start()
        Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
        const provider = await createConnection(connection(), { name: 'Disposable local provider', provider: 'openrouter', models: ['qa-local'], extraModels: [], baseUrl: fixture.providerOrigin, keys: { OPENROUTER_API_KEY: 'fixture-only' } })
        await setBoxDefault(connection(), { connectionId: provider.id, model: 'qa-local' })
        const config = { enabled: true, connectionId: provider.id, provider: 'openrouter' as const, selfImprovement: { enabled: false, autoMemory: false } }
        const first = await createAgent(connection(), { config: { ...config, name: 'alice' } })
        const second = await createAgent(connection(), { config: { ...config, name: 'bob' } })
        let db = await openDesktopDatabase(root)
        const alice = await createDesktopAgent(db, { name: 'Alice', engineAgentId: first.id })
        const bob = await createDesktopAgent(db, { name: 'Bob', engineAgentId: second.id })
        const response = await chat(request('/api/desktop/chat', 'POST', { agentId: alice.id, text: 'Keep this conversation. Do not use tools.' }))
        expect(response.status).toBe(200)
        const sessionId = response.headers.get('x-session-id')!
        const streaming = response.text()
        await fixture.providerStarted
        expect((await toggle(alice.id, false)).status).toBe(200)
        expect((await getAgent(connection(), first.id)).config.enabled).toBe(false)
        fixture.finishReply()
        expect(await streaming).toContain('A completed local run.')
        let saved: Awaited<ReturnType<typeof readDesktopHistory>> = []
        await vi.waitFor(async () => {
            saved = await readDesktopHistory(fixture.runtime, sessionId)
            expect(JSON.stringify(saved)).toContain('A completed local run.')
        })
        expect((await chat(request('/api/desktop/chat', 'POST', { agentId: alice.id, sessionId, text: 'Blocked while off' }))).status).toBe(403)
        expect((await engineChat(connection(), first.id, { message: 'Direct engine must also refuse' })).status).toBe(403)
        expect(await readDesktopHistory(fixture.runtime, sessionId)).toEqual(saved)
        expect(await listDesktopSessions(db, bob.id)).toEqual([])
        await closeDesktopDatabase(root)
        await fixture.stop()
        await fixture.start()
        db = await openDesktopDatabase(root)
        const restored = await roster(request('/api/desktop/agents'))
        expect((await restored.json()).agents).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: alice.id, enabled: false }), expect.objectContaining({ id: bob.id, enabled: true }),
        ]))
        expect(await readDesktopHistory(fixture.runtime, sessionId)).toEqual(saved)
        expect((await chat(request('/api/desktop/chat', 'POST', { agentId: alice.id, text: 'Still blocked after restart', tabUid: 'off-after-restart' }))).status).toBe(403)
        expect((await listDesktopSessions(db, alice.id)).map(session => session.id)).toEqual([sessionId])
        expect((await toggle(alice.id, true)).status).toBe(200)
        const resumed = await chat(request('/api/desktop/chat', 'POST', { agentId: alice.id, sessionId, text: 'Continue the same conversation.' }))
        expect(resumed.status).toBe(200)
        expect(resumed.headers.get('x-session-id')).toBe(sessionId)
        const resumedText = resumed.text()
        await fixture.waitForProviderRequest(2)
        fixture.finishReply()
        expect(await resumedText).toContain('A completed local run.')
        expect(JSON.stringify(fixture.providerMessages[1])).toContain('Keep this conversation.')
        expect(fixture.providerMessages).toHaveLength(2)
        await closeDesktopDatabase(root)
        await fixture.stop()
        await fixture.start()
        expect((await getAgent(connection(), first.id)).config.enabled).toBe(true)
        expect((await readDesktopHistory(fixture.runtime, sessionId)).length).toBeGreaterThan(saved.length)
        expect(await listDesktopSessions(await openDesktopDatabase(root), bob.id)).toEqual([])
    } finally {
        await closeDesktopDatabase(root)
        await fixture.close()
        process.env = originalEnv
        await rm(root, { recursive: true, force: true })
    }
}, 60000)
