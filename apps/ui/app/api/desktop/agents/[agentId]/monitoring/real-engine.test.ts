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

test.runIf(process.env.RERUN_RUN_HISTORY_ACCEPTANCE === '1')('a real desktop engine reports monitoring scoped per coworker', async () => {
    const originalEnv = { ...process.env }
    const root = await mkdtemp(join(tmpdir(), 'rerun-real-monitoring-'))
    const fixture = await disposableRunEngine(root)
    const request = (path: string, body?: unknown) => new Request(`${fixture.runtime.app.origin}${path}`, {
        method: body ? 'POST' : 'GET', headers: { host: new URL(fixture.runtime.app.origin).host, origin: fixture.runtime.app.origin,
            cookie: `rerun-desktop-session=${fixture.runtime.app.sessionToken}`, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const monitoring = async (agentId: string) => {
        const response = await GET(request(`/api/desktop/agents/${agentId}/monitoring`), { params: Promise.resolve({ agentId }) })
        expect(response.status).toBe(200)
        return response.json()
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
        expect((await monitoring(alice.id)).runs).toEqual([])
        const response = await chat(request('/api/desktop/chat', { agentId: alice.id, text: 'Reply with a short answer. Do not use tools.' }))
        expect(response.status).toBe(200)
        const streamed = response.text()
        await fixture.providerStarted
        fixture.finishReply()
        expect(await streamed).toContain('A completed local run.')
        await vi.waitFor(async () => { expect((await monitoring(alice.id)).runs.length).toBeGreaterThan(0) })
        const body = await monitoring(alice.id)
        expect(body.agentId).toBe(alice.id)
        expect(body.range).toBe('7d')
        expect(body.runs.reduce((sum: number, p: { value: number }) => sum + p.value, 0)).toBe(1)
        expect(body.errorRate).toBeInstanceOf(Array)
        expect(body.totalTokens).toBeInstanceOf(Array)
        const other = await monitoring(bob.id)
        expect(other.runs).toEqual([])
        expect(other.agentId).toBe(bob.id)
    } finally {
        await closeDesktopDatabase(root)
        await fixture.close()
        process.env = originalEnv
        await rm(root, { recursive: true, force: true })
    }
}, 45000)
