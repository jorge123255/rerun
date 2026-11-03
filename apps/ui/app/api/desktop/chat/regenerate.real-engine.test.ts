import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { readDesktopHistory } from '@/lib/desktop/server/engine'
import { createDesktopAgent, listDesktopSessions } from '@/lib/desktop/server/store'
import { createAgent, createConnection, setBoxDefault } from '@/lib/engine/client'
import { disposableRunEngine } from '@/test/desktop-run-engine.mjs'
import { POST as chat } from './route'

test.runIf(process.env.RERUN_REGENERATE_ACCEPTANCE === '1')('an older attached question forks from its saved context exactly once across restart', async () => {
    const env = { ...process.env }
    const root = await mkdtemp(join(tmpdir(), 'rerun-regenerate-'))
    const engine = await disposableRunEngine(root, undefined, { replyForRequest: n => 'Reply number ' + n })
    function post(body: object) {
        const { origin, sessionToken } = engine.runtime.app
        return chat(new Request(origin + '/api/desktop/chat', { method: 'POST', headers: {
            host: new URL(origin).host, origin, cookie: 'rerun-desktop-session=' + sessionToken, 'content-type': 'application/json',
        }, body: JSON.stringify(body) }))
    }
    async function send(body: object, n: number) {
        const response = await post(body)
        expect(response.status).toBe(200)
        const stream = response.text()
        await engine.waitForProviderRequest(n)
        engine.finishReply()
        expect(await stream).toContain('Reply number ' + n)
        return response.headers.get('x-session-id')!
    }
    try {
        const runtime = await engine.start()
        Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
        const conn = { baseUrl: runtime.engine.origin, apiKey: runtime.engine.apiKey }
        const provider = await createConnection(conn, { name: 'Test provider', provider: 'openrouter', models: ['qa-local'], extraModels: [], baseUrl: engine.providerOrigin, keys: { OPENROUTER_API_KEY: 'fixture-only' } })
        await setBoxDefault(conn, { connectionId: provider.id, model: 'qa-local' })
        const agent = await createAgent(conn, { config: { name: 'notebook', connectionId: provider.id, provider: 'openrouter', tools: { memory: false }, selfImprovement: { enabled: false } } })
        const { id: agentId } = await createDesktopAgent(await openDesktopDatabase(root), { name: 'Notebook', engineAgentId: agent.id })
        const workspace = join(root, 'workspaces/1/engine/agents', agent.id, 'workspace')
        await mkdir(workspace, { recursive: true })
        const file = join(workspace, 'note.md')
        await writeFile(file, 'Agate 7219')
        const source = await send({ agentId, text: 'What is the stone?', attachmentPath: 'note.md' }, 1)
        await send({ agentId, sessionId: source, text: 'The later-only marker is orchid 3874.' }, 2)
        const original = await readDesktopHistory(runtime, source)
        expect(original.map(row => row.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
        await writeFile(file, 'Quartz 5361')
        const request = { agentId, sessionId: source, regenerateMessageId: original[1].id, requestId: crypto.randomUUID() }
        const alternate = await send(request, 3)
        expect(alternate).not.toBe(source)
        const context = JSON.stringify(engine.providerMessages[2])
        expect(context.match(/Agate 7219/g)).toHaveLength(1)
        expect(context).not.toMatch(/orchid 3874|Quartz 5361|Reply number 1|Reply number 2/)
        // No one has opened the alternate yet. A remounted source no longer has the first UUID.
        expect(await readDesktopHistory(runtime, source)).toEqual(original)
        const retry = () => post({ ...request, requestId: crypto.randomUUID() })
        const beforeRestart = await retry()
        expect(beforeRestart.headers.get('x-session-id')).toBe(alternate)
        await beforeRestart.text()
        await closeDesktopDatabase(root)
        await engine.stop()
        const restarted = await engine.start()
        const replay = await retry()
        expect(replay.headers.get('x-session-id')).toBe(alternate)
        expect(await replay.text()).toBe('data: [DONE]\n\n')
        expect(await readDesktopHistory(restarted, source)).toEqual(original)
        const regenerated = await readDesktopHistory(restarted, alternate)
        expect(regenerated.map(m => m.role)).toEqual(['user', 'assistant'])
        expect(regenerated[0].metadata?.attachmentPath).toBe('note.md')
        expect(regenerated[1].parts).toContainEqual({ type: 'text', text: 'Reply number 3' })
        expect(await listDesktopSessions(await openDesktopDatabase(root), agentId)).toHaveLength(2)
        expect(engine.providerMessages).toHaveLength(3)
        const another = await send({ ...request, requestId: crypto.randomUUID() }, 4)
        expect(another).not.toBe(alternate)
    } finally {
        await closeDesktopDatabase(root)
        await engine.close()
        process.env = env
        await rm(root, { recursive: true, force: true })
    }
}, 45000)
