import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { disposableRunEngine } from '@/test/desktop-run-engine.mjs'
import { seedRecordedToolFixture } from '@/test/desktop-run-telemetry.mjs'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent } from '@/lib/desktop/server/store'
import { cancelRun, createAgent, createConnection, setBoxDefault, listRuns as listEngineRuns } from '@/lib/engine/client'
import { POST as chat } from '@/app/api/desktop/chat/route'
import { GET as listRuns } from '@/app/api/desktop/agents/[agentId]/runs/route'
import { GET } from './route'

test.runIf(process.env.RERUN_RUN_DETAILS_ACCEPTANCE === '1')('completed and cancelled real run details stay scoped and reopen after engine restart', async () => {
    const originalEnv = { ...process.env }
    const root = await mkdtemp(join(tmpdir(), 'rerun-real-details-'))
    const fixture = await disposableRunEngine(root)
    const request = (path: string, body?: unknown) => new Request(`${fixture.runtime.app.origin}${path}`, {
        method: body ? 'POST' : 'GET', headers: { host: new URL(fixture.runtime.app.origin).host, origin: fixture.runtime.app.origin,
            cookie: `rerun-desktop-session=${fixture.runtime.app.sessionToken}`, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const list = async (agentId: string) => (await (await listRuns(request(`/api/desktop/agents/${agentId}/runs`), { params: Promise.resolve({ agentId }) })).json()).runs
    const details = (agentId: string, runId: string) => GET(request(`/api/desktop/agents/${agentId}/runs/${runId}/details`), { params: Promise.resolve({ agentId, runId }) })
    try {
        const runtime = await fixture.start()
        Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
        const conn = { baseUrl: runtime.engine.origin, apiKey: runtime.engine.apiKey }
        const provider = await createConnection(conn, { name: 'Disposable provider', provider: 'openrouter', models: ['qa-local'], extraModels: [], baseUrl: fixture.providerOrigin, keys: { OPENROUTER_API_KEY: 'fixture-only' } })
        await setBoxDefault(conn, { connectionId: provider.id, model: 'qa-local' })
        const engineAlice = await createAgent(conn, { config: { name: 'alice', enabled: true, connectionId: provider.id, provider: 'openrouter' } })
        const engineBob = await createAgent(conn, { config: { name: 'bob', enabled: true, connectionId: provider.id, provider: 'openrouter' } })
        const db = await openDesktopDatabase(root)
        const alice = await createDesktopAgent(db, { name: 'Alice', engineAgentId: engineAlice.id })
        const bob = await createDesktopAgent(db, { name: 'Bob', engineAgentId: engineBob.id })
        const first = await chat(request('/api/desktop/chat', { agentId: alice.id, text: 'Give a short answer. Do not use tools.' }))
        expect(first.status).toBe(200)
        const firstText = first.text()
        await fixture.waitForProviderRequest(1)
        const completedId = (await list(alice.id))[0].id
        fixture.finishReply()
        await firstText
        await vi.waitFor(async () => { expect((await list(alice.id))[0].status).toBe('done') })
        const completedResponse = await details(alice.id, completedId)
        expect(completedResponse.status).toBe(200)
        const completed = await completedResponse.json()
        expect(completed.steps).toHaveLength(1)
        expect(completed.steps[0]).toMatchObject({ stepNumber: 1, finishReason: 'stop', totalTokens: 16 })
        expect(completed.tools).toEqual([])
        expect((await details(bob.id, completedId)).status).toBe(404)

        const second = await chat(request('/api/desktop/chat', { agentId: alice.id, text: 'This disposable run will be cancelled.' }))
        expect(second.status).toBe(200)
        const cancelledText = second.text().catch(() => '')
        await fixture.waitForProviderRequest(2)
        const cancelledId = (await list(alice.id)).find((run: { status: string }) => run.status === 'running').id
        await cancelRun(conn, engineAlice.id, cancelledId)
        await cancelledText
        await vi.waitFor(async () => { expect((await list(alice.id)).find((run: { id: string }) => run.id === cancelledId).status).toBe('cancelled') })
        const cancelledResponse = await details(alice.id, cancelledId)
        expect(cancelledResponse.status).toBe(200)
        const cancelled = await cancelledResponse.json()
        expect(cancelled).toEqual({ steps: [], tools: [] })
        expect((await details(bob.id, cancelledId)).status).toBe(404)
        const sessionId = (await listEngineRuns(conn, engineAlice.id))[0].sessionId
        const fixtureId = await seedRecordedToolFixture(root, engineAlice.id, sessionId)
        const recorded = await (await details(alice.id, fixtureId)).json()
        expect(recorded.steps[0].finishReason).toBe('tool-calls')
        expect(recorded.tools.map((tool: { toolName: string }) => tool.toolName)).toEqual(['fixture_lookup', 'fixture_failed_lookup', 'fixture_incomplete_lookup'])
        expect((await details(bob.id, fixtureId)).status).toBe(404)
        await closeDesktopDatabase(root)
        await fixture.stop()
        await fixture.start()
        expect(await (await details(alice.id, completedId)).json()).toEqual(completed)
        expect(await (await details(alice.id, cancelledId)).json()).toEqual(cancelled)
        expect(await (await details(alice.id, fixtureId)).json()).toEqual(recorded)
        expect((await details(bob.id, completedId)).status).toBe(404)
        expect((await details(bob.id, cancelledId)).status).toBe(404)
    } finally {
        await closeDesktopDatabase(root)
        await fixture.close()
        process.env = originalEnv
        await rm(root, { recursive: true, force: true })
    }
}, 45000)
