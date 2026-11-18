import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test, vi } from 'vitest'
import { openDesktopDatabase, closeDesktopDatabase } from '../database'
import { replaceDesktopForemanCallAllows } from '../coworker-calls/authority'
import { createDesktopAgent, createDesktopSession } from '../store'
import { ensureForemanChat } from './chat-store'
import { inspectChiefSetup } from './setup-coordination'
import type { DesktopRuntime } from '../runtime'

// Serve the production engine routes on a fresh loopback port. Use disposable SQLite stores for
// both sides, real Foreman contact admission and a real claimed setup chat. No model is called.
test('a Chief can inspect the active setup chat with no MCP or tool-install grants, and loses access on revoke', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'rerun-chief-setup-')))
    const storage = join(root, 'workspaces', '1', 'engine')
    const runtimeFile = join(root, 'fixture-runtime.json')
    const key = 'a'.repeat(64)
    vi.stubEnv('RERUN_API_KEY', key)
    vi.stubEnv('RERUN_DATA_DIR', storage)
    vi.stubEnv('RERUN_LOG_LEVEL', 'error')
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    vi.stubEnv('RERUN_DESKTOP_DATA_DIR', root)
    vi.stubEnv('RERUN_DESKTOP_INSTALL_DIR', root)
    vi.stubEnv('RERUN_DESKTOP_WORKSPACE_ID', '1')
    vi.stubEnv('RERUN_DESKTOP_RUNTIME_FILE', runtimeFile)
    const engine = (file: string) => import(/* @vite-ignore */ pathToFileURL(resolve(import.meta.dirname, '../../../../../engine/src', file)).href)
    const { clearCachedEnvForTests } = await engine('config/env.ts')
    clearCachedEnvForTests()
    const { dataDir, agentDir, installPath } = await engine('config/paths.ts')
    expect(dataDir()).toBe(storage)
    expect(agentDir('qa')).toBe(join(storage, 'agents', 'qa'))
    const { closeSystemDb } = await engine('db/systemDb.ts')
    const db = await openDesktopDatabase(root)
    const api = (await engine('http/server.ts')).createServer()
    const server = createServer(async (req, res) => {
        try {
            const chunks = []
            for await (const chunk of req) chunks.push(chunk)
            const response = await api.request(req.url, { method: req.method, headers: req.headers, ...(chunks.length && { body: Buffer.concat(chunks) }) })
            res.writeHead(response.status, Object.fromEntries(response.headers)).end(Buffer.from(await response.arrayBuffer()))
        } catch { res.writeHead(500).end() }
    })
    try {
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
        const address = server.address()
        if (!address || typeof address === 'string') throw new Error('Missing disposable engine address')
        const origin = 'http://127.0.0.1:' + address.port
        const runtime: DesktopRuntime = { protocolVersion: 1, workspaceId: 1, launchNonce: randomUUID(), buildId: 'fixture', dataRoot: root,
            app: { origin, sessionToken: 'b'.repeat(32) }, engine: { origin, apiKey: key } }
        await writeFile(runtimeFile, JSON.stringify(runtime), { mode: 0o600 })
        const { agentConfigSchema } = await engine('agents/types.ts')
        const { writeAgentConfig } = await engine('agents/config-write.ts')
        for (const [id, config] of [['foreman', { kind: 'foreman', tools: { desktopToolGrants: { callAgent: true } } }], ['qa', { setup: { required: true } }]] as const) {
            await mkdir(agentDir(id), { recursive: true })
            await writeAgentConfig(id, agentConfigSchema.parse({ name: id, ...config }))
        }
        await writeFile(installPath('qa'), 'Ask which platform to test.\n')
        const { claimDesktopSetupSession } = await engine('desktop/setup/service.ts')
        const { session } = await claimDesktopSetupSession('qa')
        const target = await createDesktopAgent(db, { name: 'QA tester', engineAgentId: 'qa' })
        const local = await createDesktopSession(db, { agentId: target.id, engineSessionId: session.id, title: 'Setup' })
        const { appendMessage } = await engine('db/repos/messages.ts')
        await appendMessage('qa', session.id, { role: 'assistant', content: [{ type: 'text', text: 'Which platform?' }] })
        const chief = await ensureForemanChat(db, '1')
        const chiefSession = await (await engine('db/repos/sessions.ts')).createSession('foreman')
        await db.execute({ sql: 'UPDATE desktop_foreman_chats SET engine_session_id=? WHERE chat_id=?', args: [chiefSession.id, chief.chat.chatId] })
        const run = await (await engine('db/repos/runs.ts')).startRun('foreman', chiefSession.id)
        const binding = { ...chief.chat, runId: run.id, model: { connectionId: 'test', model: 'fixture' } }
        await db.execute({ sql: 'INSERT INTO desktop_foreman_turns(request_id,chat_id,fingerprint,body,status,created_at) VALUES(?,?,?,?,?,?)',
            args: [run.id, chief.chat.chatId, 'fixture', JSON.stringify({ binding, sessionId: chiefSession.id }), 'admitted', new Date().toISOString()] })
        await replaceDesktopForemanCallAllows(db, chief.chat, [target.id], [])
        const inspect = () => inspectChiefSetup(runtime, db, binding, 'QA tester', AbortSignal.timeout(10_000))
        expect(await inspect()).toMatchObject({ state: 'awaiting_reply', lastMessage: 'Which platform?', agentId: target.id, step: { sessionId: local.id } })
        // A real ask_user acknowledgement changes who can act. The Chief gets the public
        // setup chat link; neither the private options nor an ordinary replyable step escape.
        const toolCallId = 'private-setup-question'
        await appendMessage('qa', session.id, { role: 'assistant', content: [{ type: 'tool-call', toolName: 'ask_user', toolCallId,
            input: { questions: [{ question: 'Which team owns the rollout?', options: ['Private A', 'Private B'] }] } }] })
        await appendMessage('qa', session.id, { role: 'tool', content: [{ type: 'tool-result', toolName: 'ask_user', toolCallId,
            output: { type: 'json', value: { status: 'delivered' } } }] })
        await appendMessage('qa', session.id, { role: 'assistant', content: 'Please answer the card.' })
        expect(await inspect()).toEqual({ agentId: target.id, coworker: 'QA tester', state: 'needs_owner', blocker: 'question', ownerSessionId: local.id, ownerQuestionId: expect.stringMatching(/^[0-9a-f]{64}$/) })
        await appendMessage('qa', session.id, { role: 'assistant', content: [{ type: 'tool-call', toolName: 'request_secret', toolCallId: 'additional-form', input: {} }] })
        await appendMessage('qa', session.id, { role: 'assistant', content: [{ type: 'tool-call', toolName: 'ask_user', toolCallId, input: { questions: [{ question: 'Which team?', options: ['QA', 'Dev'] }] } }] })
        await appendMessage('qa', session.id, { role: 'tool', content: [{ type: 'tool-result', toolName: 'ask_user', toolCallId, output: { type: 'json', value: { status: 'delivered' } } }] })
        expect(await inspect()).toEqual({ agentId: target.id, coworker: 'QA tester', state: 'needs_owner', blocker: 'question', ownerSessionId: local.id })
        await replaceDesktopForemanCallAllows(db, chief.chat, [], [target.id])
        await expect(inspect()).rejects.toMatchObject({ status: 403 })
    } finally {
        await new Promise<void>(resolve => server.close(() => resolve()))
        closeSystemDb('qa')
        closeSystemDb('foreman')
        await closeDesktopDatabase(root)
        clearCachedEnvForTests()
        vi.unstubAllEnvs()
        await rm(root, { recursive: true, force: true })
    }
}, 30_000)
