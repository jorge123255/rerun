import { createHmac, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import type { DesktopClaudePlanAction, DesktopClaudePlanSnapshot, DesktopClaudePlanCredential } from '@rerun/contracts'
const observed = vi.hoisted(() => ({ calls: 0 }))
vi.mock('../../runtime/loop.js', async original => ({
    ...await original<typeof import('../../runtime/loop.js')>(),
    runAgent: async (agent: any, sessionId: string, _message: string, override: any, _writer: unknown, runId: string) => {
        expect(agent.resolved.connection.id).toBe('mac-claude')
        expect(agent.resolved.connection.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('synthetic-replacement-generation-2')
        expect(agent.resolved.connection.env.RERUN_CLAUDE_CREDENTIAL_REVISION).toBe('2')
        expect(override.connectionId).toBe('mac-claude')
        observed.calls++
        const { appendMessage } = await import('../../db/repos/messages.js')
        const { finishRun } = await import('../../db/repos/runs.js')
        const { releaseSession } = await import('../../runtime/run-control.js')
        await appendMessage(agent.id, sessionId, { role: 'assistant', content: 'Synthetic replacement reply' })
        await finishRun(agent.id, runId, null, 1); releaseSession(runId)
        return { runId, settled: Promise.resolve({ kind: 'done' }), result: { toUIMessageStream: () => new ReadableStream({ start(controller) { controller.enqueue({ type: 'start' }); controller.enqueue({ type: 'text-start', id: 't' }); controller.enqueue({ type: 'text-delta', id: 't', delta: 'Synthetic replacement reply' }); controller.enqueue({ type: 'text-end', id: 't' }); controller.enqueue({ type: 'finish' }); controller.close() } }) } }
    },
}))

it('reconnect persists one singleton, stale cancelled exchange cannot replace it, and canonical queued turn admits one synthetic reply after reopen', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'claude-restart-turn-'))
    vi.stubEnv('RERUN_DATA_DIR', directory); vi.stubEnv('RERUN_DESKTOP_APP', '1'); vi.stubEnv('RERUN_DESKTOP_SECRET_KEY', 'c'.repeat(64)); vi.stubEnv('RERUN_API_KEY', '')
    observed.calls = 0
    const { DEFAULT_CONNECTION_MODELS, boxDefaultModelSchema } = await import('@rerun/contracts')
    const { createConnection } = await import('../../connections/store.js')
    const { findConnection, unloadConnection, reloadConnection, listConnections } = await import('../../connections/registry.js')
    const { recordCredentialRejected, isCredentialRejected, forgetCredentialRejected } = await import('../../connections/credential-rejections.js')
    const { writeEnvFile, readEnvFile } = await import('../../lib/env-file.js')
    const { withConnectionLock } = await import('../../connections/lock.js')
    const { connectionEnvPath, agentDir, boxDefaultPath } = await import('../../config/paths.js')
    const { writeBoxDefault, readBoxDefault } = await import('../../connections/default.js')
    const { createDesktopClaudePlanAuth } = await import('./auth.js')
    const { agentConfigSchema } = await import('../../agents/types.js')
    const { writeAgentConfig } = await import('../../agents/config-write.js')
    const { createSession, getSession } = await import('../../db/repos/sessions.js')
    const { closeSystemDb } = await import('../../db/systemDb.js')
    const { listMessages } = await import('../../db/repos/messages.js')
    const { createServer } = await import('../../http/server.js')
    const model = DEFAULT_CONNECTION_MODELS.claude[0]!, owner = 'claude-fixture-owner'
    let finish!: (value: DesktopClaudePlanCredential) => void, enter!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    let deferred = true
    const ports = {
        read: () => readEnvFile(connectionEnvPath('mac-claude')),
        write: (value: Record<string, string>) => writeEnvFile(connectionEnvPath('mac-claude'), value),
        lock: <T>(work: () => Promise<T>) => withConnectionLock('mac-claude', work),
        exchange: async (): Promise<DesktopClaudePlanCredential> => { if (deferred) { enter(); return new Promise(resolve => { finish = resolve }) } return { accessToken: 'synthetic-replacement-generation-2' } },
        fingerprint: (value: string) => createHmac('sha256', 'synthetic-fixture-hmac').update(value).digest('hex'), available: () => true, now: () => 1000, launchNonce: 'fixture-a',
        beforeCredentialChange: async () => {}, changed: async () => { forgetCredentialRejected('mac-claude'); await reloadConnection('mac-claude') },
    }
    const action = (operation: 'start' | 'complete' | 'cancel', snapshot: DesktopClaudePlanSnapshot): DesktopClaudePlanAction => operation === 'complete'
        ? { operation, requestId: randomUUID(), attemptId: snapshot.attemptId, expectedRevision: snapshot.revision, code: 'synthetic-code' }
        : { operation, requestId: randomUUID(), attemptId: snapshot.attemptId, expectedRevision: snapshot.revision }
    const signal = () => new AbortController().signal
    let auth = createDesktopClaudePlanAuth(ports)
    try {
        await createConnection({ name: 'Claude', provider: 'claude', models: [model], extraModels: [], keys: { CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-old-rejected' } }, 'mac-claude')
        await ports.write({ ...(await ports.read()), RERUN_CLAUDE_CREDENTIAL_REVISION: '1' })
        recordCredentialRejected('mac-claude')
        await writeBoxDefault({ connectionId: 'mac-claude', model })
        const a = await auth.action(action('start', await auth.status()), signal())
        const staleInput = action('complete', a), stale = auth.action(staleInput, signal())
        await entered
        const cancelled = await auth.action(action('cancel', await auth.status()), signal())
        expect(cancelled.credentialRevision).toBe('1'); expect(isCredentialRejected('mac-claude')).toBe(true)
        deferred = false
        const b = await auth.action(action('start', cancelled), signal())
        const connected = await auth.action(action('complete', b), signal())
        expect(connected.credentialRevision).toBe('2'); expect(isCredentialRejected('mac-claude')).toBe(false)
        finish({ accessToken: 'synthetic-stale-must-not-displace' }); await stale
        expect((await ports.read()).CLAUDE_CODE_OAUTH_TOKEN).toBe('synthetic-replacement-generation-2')
        await expect(auth.action(staleInput, signal())).rejects.toThrow(/changed/)
        expect((await readFile(connectionEnvPath('mac-claude'), 'utf8'))).not.toContain('synthetic-replacement-generation-2')
        await mkdir(agentDir(owner), { recursive: true }); await writeAgentConfig(owner, agentConfigSchema.parse({ name: 'Fixture', connectionId: 'mac-claude', provider: 'claude', model, enabled: true }))
        const session = await createSession(owner, undefined, undefined, 'dashboard')
        closeSystemDb(owner); auth.stop(); unloadConnection('mac-claude')
        auth = createDesktopClaudePlanAuth({ ...ports, launchNonce: 'fixture-b' })
        expect(await auth.status()).toMatchObject({ phase: 'connected', credentialRevision: '2', attemptId: null })
        const recoveredChoice = boxDefaultModelSchema.parse(JSON.parse(await readFile(boxDefaultPath(), 'utf8')))
        expect(recoveredChoice).toEqual({ connectionId: 'mac-claude', model })
        expect(await readBoxDefault()).toEqual(recoveredChoice)
        expect((await findConnection('mac-claude'))?.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('synthetic-replacement-generation-2')
        expect((await listConnections()).filter(connection => connection.config.provider === 'claude').map(connection => connection.id)).toEqual(['mac-claude'])
        const app = createServer(), runId = randomUUID()
        const input = { sessionId: session.id, message: 'One synthetic reply after restart', ...recoveredChoice, source: 'dashboard', desktopQueuedTurn: { runId } }
        for (let replay = 0; replay < 2; replay++) {
            const response = await app.request(`/agents/${owner}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
            expect([200, 204]).toContain(response.status)
            expect(response.headers.get('x-session-id')).toBe(session.id); expect(response.headers.get('x-run-id')).toBe(runId)
            await response.text()
        }
        expect(observed.calls).toBe(1)
        expect((await listMessages(owner, session.id)).filter(row => row.role === 'assistant')).toHaveLength(1)
        expect((await getSession(owner, session.id))?.agentId).toBe(owner)
        expect((await ports.read()).CLAUDE_CODE_OAUTH_TOKEN).toBe('synthetic-replacement-generation-2')
    } finally { finish?.({ accessToken: 'synthetic-cleanup' }); auth.stop(); closeSystemDb(owner); unloadConnection('mac-claude'); await rm(directory, { recursive: true, force: true }); vi.unstubAllEnvs() }
}, 30_000)
