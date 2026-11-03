import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { disposableRunEngine } from '@/test/desktop-run-engine.mjs'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent, type DesktopAgent } from '@/lib/desktop/server/store'
import { createAgent, createConnection, setBoxDefault } from '@/lib/engine/client'
import { POST as chat } from '@/app/api/desktop/chat/route'
import { GET as messages } from '@/app/api/desktop/sessions/[sessionId]/messages/route'
import { GET } from './route'

test.runIf(process.env.RERUN_FIND_CHAT_ACCEPTANCE === '1')('same-title chats preserve exact coworker replies across a real engine process restart', async () => {
    const originalEnv = { ...process.env }
    const root = await mkdtemp(join(tmpdir(), 'rerun-find-chat-real-'))
    const fixture = await disposableRunEngine(root, 'http://127.0.0.1:3189', { replyForRequest: (index: number) => index === 1 ? 'Alice saved reply.' : index === 2 ? 'Bob saved reply.' : 'A newer reply.' })
    const request = (path: string, body?: unknown) => new Request(`${fixture.runtime.app.origin}${path}`, {
        method: body ? 'POST' : 'GET', headers: { host: new URL(fixture.runtime.app.origin).host, origin: fixture.runtime.app.origin,
            cookie: `rerun-desktop-session=${fixture.runtime.app.sessionToken}`, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const search = async (query: string) => {
        const response = await GET(request(`/api/desktop/conversations/search?q=${encodeURIComponent(query)}`))
        expect(response.status).toBe(200)
        return response.json()
    }
    const transcript = async (sessionId: string) => {
        const response = await messages(request(`/api/desktop/sessions/${sessionId}/messages`), { params: Promise.resolve({ sessionId }) })
        expect(response.status).toBe(200)
        return response.text()
    }
    const send = async (agentId: string, text: string, count: number) => {
        const response = await chat(request('/api/desktop/chat', { agentId, text }))
        expect(response.status).toBe(200)
        const stream = response.text()
        await fixture.waitForProviderRequest(count)
        fixture.finishReply()
        await stream
        return response.headers.get('x-session-id')!
    }
    try {
        const runtime = await fixture.start()
        Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
        const conn = { baseUrl: runtime.engine.origin, apiKey: runtime.engine.apiKey }
        const provider = await createConnection(conn, { name: 'Disposable local provider', provider: 'openrouter', models: ['qa-local'], extraModels: [], baseUrl: fixture.providerOrigin, keys: { OPENROUTER_API_KEY: 'fixture-only' } })
        await setBoxDefault(conn, { connectionId: provider.id, model: 'qa-local' })
        const db = await openDesktopDatabase(root)
        const coworkers: DesktopAgent[] = []
        for (const name of ['Alice', 'Bob']) {
            const engine = await createAgent(conn, { config: { name: name.toLowerCase(), displayName: name, enabled: true, connectionId: provider.id, provider: 'openrouter',
                selfImprovement: { enabled: false, autoMemory: false, allowToolInstall: false, allowSoulEdit: false } } })
            coworkers.push(await createDesktopAgent(db, { name, engineAgentId: engine.id }))
        }
        const aliceChat = await send(coworkers[0].id, 'Shared plan', 1)
        const bobChat = await send(coworkers[1].id, 'Shared plan', 2)
        await send(coworkers[0].id, 'Newer note', 3)
        await send(coworkers[1].id, 'Newer note', 4)
        expect(JSON.stringify(fixture.providerMessages[0])).toContain('Shared plan')
        expect(JSON.stringify(fixture.providerMessages[1])).toContain('Shared plan')
        const verify = async () => {
            const found = await search('Shared')
            expect(found.hits).toEqual([
                { id: bobChat, agentId: coworkers[1].id, agentName: 'Bob', title: 'Shared plan' },
                { id: aliceChat, agentId: coworkers[0].id, agentName: 'Alice', title: 'Shared plan' },
            ])
            const alice = await transcript(found.hits[1].id)
            const bob = await transcript(found.hits[0].id)
            expect(alice).toContain('Alice saved reply.')
            expect(alice).not.toMatch(/Bob saved reply|A newer reply/)
            expect(bob).toContain('Bob saved reply.')
            expect(bob).not.toContain('Alice saved reply.')
            expect(await search('Missing match')).toEqual({ hits: [], hasMore: false })
            expect(await search('Alice saved reply')).toEqual({ hits: [], hasMore: false })
        }
        await verify()
        await closeDesktopDatabase(root)
        await fixture.stop()
        await fixture.start()
        await verify()
    } finally {
        await closeDesktopDatabase(root)
        await fixture.close()
        process.env = originalEnv
        await rm(root, { recursive: true, force: true })
    }
}, 45000)
