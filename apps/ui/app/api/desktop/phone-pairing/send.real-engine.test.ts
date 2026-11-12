import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent, createDesktopSession } from '@/lib/desktop/server/store'
import { setDesktopWorkspaceFrozen } from '@/lib/desktop/server/workspace-admission'
import { createAgent, createConnection, setBoxDefault } from '@/lib/engine/client'
import { disposableRunEngine } from '@/test/desktop-run-engine.mjs'
import { POST as desktopChat } from '../chat/route'
import { DELETE, GET, POST } from './route'

test.runIf(process.env.RERUN_PHONE_SEND_ACCEPTANCE === '1')('a phone reconnects to the same live reply and replays the saved turn after restart', async () => {
    const env = { ...process.env }
    const root = await mkdtemp(join(await realpath(tmpdir()), 'rerun-phone-send-'))
    const engine = await disposableRunEngine(root, undefined, { initialReplyForRequest: index => index === 2 ? 'Live prefix. ' : '' })
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
        const streamPath = statusPath + '&stream=1'
        for (let attempt = 0; attempt < 2; attempt++) {
            const stream = await GET(request(streamPath))
            expect(stream.headers.get('content-type')).toBe('application/x-ndjson')
            const reader = stream.body!.getReader()
            const decoder = new TextDecoder()
            let received = ''
            try {
                const deadline = AbortSignal.timeout(5000)
                const timedOut = new Promise<never>((_, reject) => deadline.addEventListener('abort', () => reject(new Error('No live prefix arrived. Frames: ' + received.slice(0, 200))), { once: true }))
                while (!received.includes('Live prefix.')) {
                    const chunk = await Promise.race([reader.read(), timedOut])
                    if (chunk.done) break
                    received += decoder.decode(chunk.value, { stream: true })
                }
                expect(received.trim().split('\n').map(line => JSON.parse(line))).toEqual([{ reset: true }, { delta: 'Live prefix.' }])
                expect(await (await GET(request(statusPath))).json()).toEqual({ status: 'running' })
            } finally { void reader.cancel().catch(() => {}) }
        }
        engine.finishReply()
        await expect.poll(async () => (await (await GET(request(statusPath))).json()).status, { timeout: 6000 }).toBe('done')
        const saved = await (await GET(request(path))).json()
        expect(saved.messages.filter((message: { role: string; content: { text: string } }) => message.role === 'user' && message.content.text === body.text)).toHaveLength(1)
        expect(saved.messages.at(-1)).toMatchObject({ role: 'assistant', content: { text: 'Live prefix. A completed local run.' } })
        expect((await GET(request(streamPath))).status).toBe(204)
        expect(engine.providerMessages).toHaveLength(2)
        await closeDesktopDatabase(root)
        await engine.stop()
        await engine.start()
        expect((await POST(request(path, 'POST', body))).status).toBe(202)
        expect(await (await GET(request(statusPath))).json()).toEqual({ status: 'done' })
        expect(await (await GET(request(path))).json()).toEqual(saved)
        expect((await DELETE(request(statusPath, 'DELETE'))).status).toBe(200)
        expect(await (await GET(request(statusPath))).json()).toEqual({ status: 'done' })
        expect(engine.providerMessages).toHaveLength(2)

        const cancellable = { runId: '4ce8e801-9bbd-8c6e-8221-2e326471724d', text: 'Stop only this phone turn' }
        const cancellablePath = path + '&runId=' + cancellable.runId
        expect((await POST(request(path, 'POST', cancellable))).status).toBe(202)
        await engine.waitForProviderRequest(3)
        const otherChat = await createDesktopSession(await openDesktopDatabase(root), { agentId: agent.id, engineSessionId: 'other-saved-chat', title: 'Other saved chat' })
        const wrongChatPath = endpoint + `?agentId=${agent.id}&chatId=${otherChat.id}&runId=${cancellable.runId}`
        expect((await DELETE(request(wrongChatPath, 'DELETE'))).status).toBe(404)
        expect(await (await GET(request(cancellablePath))).json()).toEqual({ status: 'running' })
        expect((await DELETE(request(cancellablePath, 'DELETE'))).status).toBe(200)
        await expect.poll(async () => (await (await GET(request(cancellablePath))).json()).status, { timeout: 6000 }).toBe('cancelled')
        expect((await DELETE(request(cancellablePath, 'DELETE'))).status).toBe(200)
        await engine.stop()
        await engine.start()
        expect(await (await GET(request(cancellablePath))).json()).toEqual({ status: 'cancelled' })
        expect(await (await GET(request(statusPath))).json()).toEqual({ status: 'done' })
        expect(engine.providerMessages).toHaveLength(3)
    } finally {
        await closeDesktopDatabase(root)
        await engine.close()
        process.env = env
        await rm(root, { recursive: true, force: true })
    }
}, 60_000)
