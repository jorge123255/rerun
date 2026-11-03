import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, test } from 'vitest'
import { GET as history } from '@/app/api/desktop/sessions/[sessionId]/messages/route'
import { openDesktopDatabase, closeDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent } from '@/lib/desktop/server/store'
import { createAgent, createConnection, setBoxDefault } from '@/lib/engine/client'
import { disposableRunEngine } from '@/test/desktop-run-engine.mjs'
import { PUT as saveFile } from '@/app/api/desktop/agents/[agentId]/files/content/route'
import { GET as readFile } from '@/app/api/desktop/agents/[agentId]/files/read/route'
import { POST as chat } from './route'

test.runIf(process.env.RERUN_ATTACHMENT_ACCEPTANCE === '1')('a workspace attachment follows its original chat after the file is edited in Files and the app restarts', async () => {
    const originalEnv = { ...process.env }
    const root = await mkdtemp(join(tmpdir(), 'rerun-workspace-attachment-'))
    const engine = await disposableRunEngine(root)
    const attachmentPath = 'notes/Desk reference.md'
    const question = 'What is the reference on the second line?'
    const original = 'Desk reference.\nThe answer is jacinth-7825.'
    const sibling = 'Desk reference.\nThe answer is saffron-5914.'
    const replacement = 'Desk reference.\nThe answer is changed-4623.'

    function request(path: string, body?: object) {
        const { origin, sessionToken } = engine.runtime.app
        return new Request(origin + path, { method: body ? 'POST' : 'GET', headers: {
            host: new URL(origin).host, origin, cookie: 'rerun-desktop-session=' + sessionToken, 'content-type': 'application/json',
        }, body: body && JSON.stringify(body) })
    }
    async function send(body: object, requestNumber: number) {
        const response = await chat(request('/api/desktop/chat', body))
        expect(response.status).toBe(200)
        const sessionId = response.headers.get('x-session-id')
        expect(sessionId).toBeTruthy()
        const stream = response.text()
        await engine.waitForProviderRequest(requestNumber)
        engine.finishReply()
        expect(await stream).toContain('A completed local run.')
        return sessionId!
    }
    async function transcript(sessionId: string) {
        const response = await history(request('/api/desktop/sessions/' + sessionId + '/messages'), { params: Promise.resolve({ sessionId }) })
        expect(response.status).toBe(200)
        return (await response.json()).messages
    }
    try {
        const runtime = await engine.start()
        Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
        const conn = { baseUrl: runtime.engine.origin, apiKey: runtime.engine.apiKey }
        const provider = await createConnection(conn, { name: 'Local test provider', provider: 'openrouter', models: ['qa-local'],
            extraModels: [], baseUrl: engine.providerOrigin, keys: { OPENROUTER_API_KEY: 'fixture-only' } })
        await setBoxDefault(conn, { connectionId: provider.id, model: 'qa-local' })
        const db = await openDesktopDatabase(root)
        async function coworker(name: string, content: string) {
            const agent = await createAgent(conn, { config: { name, connectionId: provider.id, provider: 'openrouter',
                selfImprovement: { enabled: false }, tools: { memory: false } } })
            const file = join(root, 'workspaces/1/engine/agents', agent.id, 'workspace', attachmentPath)
            await mkdir(dirname(file), { recursive: true })
            await writeFile(file, content)
            return { coworker: await createDesktopAgent(db, { name, engineAgentId: agent.id }), file }
        }
        const a = await coworker('reader', original)
        const b = await coworker('second-reader', sibling)
        const session = await send({ agentId: a.coworker.id, text: question, attachmentPath }, 1)
        expect(JSON.stringify(engine.providerMessages[0])).toContain('jacinth-7825')
        expect(JSON.stringify(engine.providerMessages[0])).not.toContain('saffron-5914')
        const first = await transcript(session)
        expect(first[0]).toMatchObject({ role: 'user', metadata: { attachmentPath }, parts: [{ type: 'text', text: question }] })
        expect(JSON.stringify(first)).not.toContain('jacinth-7825')
        // Edit through the Files editor's save route, with the hash the preview handed out.
        const opened = await (await readFile(request('/api/desktop/agents/' + a.coworker.id + '/files/read?path=' + encodeURIComponent(attachmentPath)),
            { params: Promise.resolve({ agentId: a.coworker.id }) })).json()
        expect(opened.content).toBe(original)
        const put = request('/api/desktop/agents/' + a.coworker.id + '/files/content', { path: attachmentPath, content: replacement, baseHash: opened.hash })
        const saved = await saveFile(new Request(put, { method: 'PUT' }), { params: Promise.resolve({ agentId: a.coworker.id }) })
        expect(saved.status).toBe(200)
        await closeDesktopDatabase(root)
        await engine.stop()
        await engine.start()
        expect(await transcript(session)).toEqual(first)
        expect(await send({ agentId: a.coworker.id, sessionId: session, text: 'Repeat the original answer.' }, 2)).toBe(session)
        const replay = JSON.stringify(engine.providerMessages[1])
        expect(replay.match(/jacinth-7825/g)).toHaveLength(1)
        expect(replay).not.toContain('changed-4623')
        const otherSession = await send({ agentId: b.coworker.id, text: question, attachmentPath }, 3)
        expect(otherSession).not.toBe(session)
        const otherInput = JSON.stringify(engine.providerMessages[2])
        expect(otherInput).toContain('saffron-5914')
        expect(otherInput).not.toContain('jacinth-7825')
        // A fresh attachment of the edited file uses the saved text.
        const fresh = await send({ agentId: a.coworker.id, text: question, attachmentPath }, 4)
        expect(fresh).not.toBe(session)
        const freshInput = JSON.stringify(engine.providerMessages[3])
        expect(freshInput).toContain('changed-4623')
        expect(freshInput).not.toContain('jacinth-7825')
        expect(freshInput).not.toContain('saffron-5914')
    } finally {
        await closeDesktopDatabase(root)
        await engine.close()
        process.env = originalEnv
        await rm(root, { recursive: true, force: true })
    }
}, 45000)
