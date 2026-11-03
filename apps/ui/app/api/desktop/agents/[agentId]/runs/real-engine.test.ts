import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { disposableRunEngine } from '@/test/desktop-run-engine.mjs'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent } from '@/lib/desktop/server/store'
import { createAgent, createConnection, setBoxDefault } from '@/lib/engine/client'
import { POST as chat } from '@/app/api/desktop/chat/route'
import { GET } from './route'

test.runIf(process.env.RERUN_RUN_HISTORY_ACCEPTANCE === '1')('a real desktop engine run progresses, remains coworker-specific, and persists across process restart', async () => {
    const originalEnv = { ...process.env }
    const root = await mkdtemp(join(tmpdir(), 'rerun-real-runs-'))
    const fixture = await disposableRunEngine(root)
    const request = (path: string, body?: unknown) => new Request(`${fixture.runtime.app.origin}${path}`, {
        method: body ? 'POST' : 'GET', headers: { host: new URL(fixture.runtime.app.origin).host, origin: fixture.runtime.app.origin,
            cookie: `rerun-desktop-session=${fixture.runtime.app.sessionToken}`, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const list = async (agentId: string) => {
        const response = await GET(request(`/api/desktop/agents/${agentId}/runs`), { params: Promise.resolve({ agentId }) })
        expect(response.status).toBe(200)
        return (await response.json()).runs
    }
    try {
        const runtime = await fixture.start()
        Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
        const conn = { baseUrl: runtime.engine.origin, apiKey: runtime.engine.apiKey }
        const provider = await createConnection(conn, { name: 'Disposable local provider', provider: 'openrouter', models: ['qa-local'], extraModels: [], baseUrl: fixture.providerOrigin, keys: { OPENROUTER_API_KEY: 'fixture-only' } })
        await setBoxDefault(conn, { connectionId: provider.id, model: 'qa-local' })
        const first = await createAgent(conn, { config: { name: 'alice', enabled: true, connectionId: provider.id, provider: 'openrouter' } })
        const second = await createAgent(conn, { config: { name: 'bob', enabled: true, connectionId: provider.id, provider: 'openrouter' } })
        const db = await openDesktopDatabase(root)
        const alice = await createDesktopAgent(db, { name: 'Alice', engineAgentId: first.id })
        const bob = await createDesktopAgent(db, { name: 'Bob', engineAgentId: second.id })
        expect(await list(alice.id)).toEqual([])
        const response = await chat(request('/api/desktop/chat', { agentId: alice.id, text: 'Reply with a short answer. Do not use tools.' }))
        expect(response.status).toBe(200)
        const streamed = response.text()
        await fixture.providerStarted
        const working = await list(alice.id)
        expect(working).toHaveLength(1)
        expect(working[0]).toMatchObject({ status: 'running', finishedAt: null })
        expect(await list(bob.id)).toEqual([])
        fixture.finishReply()
        expect(await streamed).toContain('A completed local run.')
        await vi.waitFor(async () => { expect((await list(alice.id))[0].status).toBe('done') })
        const completed = await list(alice.id)
        expect(completed[0]).toMatchObject({ id: working[0].id, status: 'done', inputTokens: 12, outputTokens: 4, totalTokens: 16, stepCount: 1 })
        expect(Date.parse(completed[0].finishedAt)).toBeGreaterThanOrEqual(Date.parse(completed[0].startedAt))
        await closeDesktopDatabase(root)
        await fixture.stop()
        await fixture.start()
        expect(await list(alice.id)).toEqual(completed)
        expect(await list(bob.id)).toEqual([])
    } finally {
        await closeDesktopDatabase(root)
        await fixture.close()
        process.env = originalEnv
        await rm(root, { recursive: true, force: true })
    }
}, 45000)
