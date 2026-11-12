import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent } from '@/lib/desktop/server/store'
import { setDesktopWorkspaceFrozen } from '@/lib/desktop/server/workspace-admission'
import { createAgent, createConnection, setBoxDefault } from '@/lib/engine/client'
import { disposableRunEngine } from '@/test/desktop-run-engine.mjs'
import { POST as desktopChat } from '../chat/route'
import { GET, POST } from './route'

test.runIf(process.env.RERUN_PHONE_SEND_ACCEPTANCE === '1')('a phone send detaches the stream and replays the exact saved turn after restart', async () => {
    const env = { ...process.env }
    const root = await mkdtemp(join(await realpath(tmpdir()), 'rerun-phone-send-'))
    const engine = await disposableRunEngine(root)
    const endpoint = '/api/desktop/phone-pairing'
    function request(path: string, method = 'GET', body?: object) {
        const { origin, sessionToken } = engine.runtime.app
        return new Request(origin + path, {
            method, headers: { host: new URL(origin).host, origin, cookie: 'rerun-desktop-session=' + sessionToken, 'content-type': 'application/json' },
            body: body && JSON.stringify(body),
        })
    }
    try {
        const runtime = await engine.start()
        Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
        const conn = { baseUrl: runtime.engine.origin, apiKey: runtime.engine.apiKey }
        const provider = await createConnection(conn, { name: 'Local phone fixture', provider: 'openrouter', models: ['qa-local'], extraModels: [], baseUrl: engine.providerOrigin, keys: { OPENROUTER_API_KEY: 'fixture-only' } })
        await setBoxDefault(conn, { connectionId: provider.id, model: 'qa-local' })
        const engineAgent = await createAgent(conn, { config: { name: 'phone-qa-worker', connectionId: provider.id, provider: 'openrouter', tools: { memory: false }, selfImprovement: { enabled: false } } })
        const db = await openDesktopDatabase(root)
        const agent = await createDesktopAgent(db, { name: 'Phone QA Worker', engineAgentId: engineAgent.id })
        const seeded = await desktopChat(request('/api/desktop/chat', 'POST', { agentId: agent.id, text: 'Start the saved chat' }))
        expect(seeded.status).toBe(200)
        const seedStream = seeded.text()
        await engine.waitForProviderRequest(1)
        engine.finishReply()
        await seedStream
        const chatId = seeded.headers.get('x-session-id')
        const path = endpoint + `?agentId=${agent.id}&chatId=${chatId}`
        const body = { runId: '4ce8e801-9bbd-8c6e-8221-2e326471724c', text: 'A message from the paired phone' }
        expect((await POST(request(path, 'POST', { ...body, modelChoice: { model: 'other' } }))).status).toBe(400)
        setDesktopWorkspaceFrozen(runtime, true)
        expect((await POST(request(path, 'POST', body))).status).toBe(409)
        setDesktopWorkspaceFrozen(runtime, false)
        const accepted = await Promise.all([POST(request(path, 'POST', body)), POST(request(path, 'POST', body))])
        expect(accepted.map(response => response.status)).toEqual([202, 202])
        expect(await accepted[0].json()).toEqual({ runId: body.runId })
        await engine.waitForProviderRequest(2)
        const statusPath = path + '&runId=' + body.runId
        expect(await (await GET(request(statusPath))).json()).toEqual({ status: 'running' })
        engine.finishReply()
        await expect.poll(async () => (await (await GET(request(statusPath))).json()).status, { timeout: 6000 }).toBe('done')
        const saved = await (await GET(request(path))).json()
        expect(saved.messages.filter((message: { role: string; content: { text: string } }) => message.role === 'user' && message.content.text === body.text)).toHaveLength(1)
        expect(saved.messages.at(-1)).toMatchObject({ role: 'assistant', content: { text: 'A completed local run.' } })
        expect(engine.providerMessages).toHaveLength(2)
        await closeDesktopDatabase(root)
        await engine.stop()
        await engine.start()
        expect((await POST(request(path, 'POST', body))).status).toBe(202)
        expect(await (await GET(request(statusPath))).json()).toEqual({ status: 'done' })
        expect(await (await GET(request(path))).json()).toEqual(saved)
        expect(engine.providerMessages).toHaveLength(2)
    } finally {
        await closeDesktopDatabase(root)
        await engine.close()
        process.env = env
        await rm(root, { recursive: true, force: true })
    }
}, 60_000)
