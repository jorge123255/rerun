import { createClient, type Client } from '@libsql/client'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    EMPTY_DRAFT,
    foremanRevisionSchema,
    type DesktopForemanBuild,
    type DesktopForemanChatRef,
    type DesktopForemanIntakeCompletionReceipt,
    type DesktopForemanRevision,
    type Run,
} from '@rerun/contracts'
import type { DesktopRuntime } from '../runtime'
import type { ForemanCreationAuthority } from './authority'

const state = vi.hoisted(() => ({ db: null as unknown as Client, agentCount: 0, creation: {} as Partial<ForemanCreationAuthority> }))
vi.mock('../database', () => ({ openDesktopDatabase: async () => state.db }))
vi.mock('../settings', () => ({
    engineOf: (runtime: DesktopRuntime) => ({ baseUrl: runtime.engine.origin, apiKey: runtime.engine.apiKey }),
    readDesktopProviders: async () => ({ connections: [{ id: 'chosen-local-model', name: 'Chosen model', provider: 'codex', connected: true, models: ['model-for-source-test', 'workspace-fixture'], extraModels: [] }] }),
    desktopModel: vi.fn(),
}))
vi.mock('../spaces', () => ({ readDesktopBoardState: async () => ({ spaces: [] }) }))
vi.mock('../store', () => ({ listDesktopAgents: async () => Array.from({ length: state.agentCount }, () => ({ id: 'existing-coworker' })) }))
vi.mock('./creation', () => ({ createDesktopForemanCreationAuthority: async () => ({ creation: state.creation, setup: {} }) }))
vi.mock('../company-discovery', () => ({
    createCompanyDiscoverySqliteStore: vi.fn(),
    createCompanyDiscoveryRuntime: () => ({ reconcile: async () => {}, close: async () => {} }),
    CompanyDiscoveryError: class extends Error {},
}))
vi.mock('../../../../../engine/src/desktop/company-discovery/index.ts', () => ({ confinedCompanyDns: vi.fn(), confinedCompanyReader: vi.fn(), runCompanyCollectors: vi.fn() }))
vi.mock('@/lib/engine/client', () => ({
    request: vi.fn(async (_engine, _path, _init, parse) => parse({ question: null })),
    EngineRequestError: class extends Error { constructor(message: string, readonly status: number) { super(message) } },
    getRun: vi.fn(async (_engine: unknown, _agent: string, id: string) => ({ id, agentId: 'foreman', sessionId: 'original-session', status: 'finished' })),
    getSessionMessages: vi.fn(async () => []), cancelRun: vi.fn(async () => {}),
}))
import { cancelRun, getRun, getSessionMessages, request } from '@/lib/engine/client'
import { desktopForeman } from './binding'
import { DESKTOP_FOREMAN_CHAT_SCHEMA, type ForemanTurn } from './chat-store'
import { FOREMAN_VOICE_SCHEMA_SQL } from '../foreman-voice/store'
import { desktopModel, readDesktopProviders } from '../settings'
import { DESKTOP_FOREMAN_SCHEMA_STATEMENTS } from './store'
import { DESKTOP_FOREMAN_INTAKE_SCHEMA_SQL, fingerprintIntakeAnswers } from '../foreman-intake'
import { createDesktopForemanIntakeBinding } from './intake'
import { initializeDesktopRound41 } from '../round41-schema'
import { POST as foremanAction } from '@/app/api/desktop/foreman/route'
import { projectPlanCard, revisionToTrustedSnapshot } from '@/lib/desktop/foreman-client/plan-view'
import { DESKTOP_FOREMAN_LIVE_REPLY_LIMIT } from '../../foreman/live-reply'

const chat = { workspaceId: '1', chatId: 'fmc_phaseprimary01' }
const answers = { companyUrl: 'acme.com', industry: 'saas' as const, decidedIndustry: null, industryLabel: null, position: 'Founder', firstName: 'Ada' }
const model = { connectionId: 'chosen-local-model', model: 'model-for-source-test' }
const planLine = 'This turn is about agreeing on what to build for them.'
const discoverLine = 'the address of their company website, what they do there, and their first name'
const timestamp = '2026-11-06T12:00:00.000Z'

describe('production Foreman intake phase and model brief', () => {
    let directory: string
    let runtime: DesktopRuntime
    let sent: ForemanTurn[]
    const open = () => createClient({ url: `file:${join(directory, 'app.sqlite')}` })
    const seedReceipt = async (completionState: DesktopForemanIntakeCompletionReceipt['state'], scope: DesktopForemanChatRef = chat) => {
        const requestId = randomUUID()
        const receipt: DesktopForemanIntakeCompletionReceipt = {
            requestId, chat: scope, fingerprint: fingerprintIntakeAnswers(answers, scope, requestId),
            state: completionState, answers,
            followUp: completionState === 'acknowledged' ? { conversationId: 'original-session', runId: requestId, industry: 'saas' } : null,
            error: null, missingAuthority: null, createdAt: timestamp, updatedAt: timestamp,
        }
        await state.db.execute({ sql: 'INSERT INTO desktop_foreman_intake_completions(request_id,workspace_id,chat_id,fingerprint,state,body,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', args: [requestId, scope.workspaceId, scope.chatId, receipt.fingerprint, completionState, JSON.stringify(receipt), timestamp, timestamp] })
        return receipt
    }
    beforeEach(async () => {
        vi.clearAllMocks()
        vi.mocked(request).mockImplementation(async (_engine, path, _init, parse) => parse(path === '/desktop/templates' ? { templates: [] } : { question: null }))
        vi.mocked(getSessionMessages).mockResolvedValue([])
        vi.mocked(getRun).mockImplementation(async (_engine, _agent, id) => ({ id, agentId: 'foreman', sessionId: 'original-session', status: 'done' }) as Awaited<ReturnType<typeof getRun>>)
        state.agentCount = 0
        state.creation = {}
        directory = await mkdtemp(join(tmpdir(), 'rerun-intake-phase-'))
        state.db = open()
        await state.db.executeMultiple([DESKTOP_FOREMAN_CHAT_SCHEMA, ...DESKTOP_FOREMAN_SCHEMA_STATEMENTS, DESKTOP_FOREMAN_INTAKE_SCHEMA_SQL, FOREMAN_VOICE_SCHEMA_SQL,
            'CREATE TABLE desktop_schema_migrations(version INTEGER PRIMARY KEY,id TEXT NOT NULL UNIQUE)',
            'CREATE TABLE desktop_workspace(id INTEGER PRIMARY KEY,name TEXT); INSERT INTO desktop_workspace VALUES(1,\'Source test workspace\');'].join(';'))
        await initializeDesktopRound41(state.db)
        await state.db.execute({ sql: 'INSERT INTO desktop_foreman_chats(chat_id,workspace_id,engine_session_id,model) VALUES(?,?,?,?)', args: [chat.chatId, chat.workspaceId, 'original-session', JSON.stringify(model)] })
        runtime = { protocolVersion: 1, workspaceId: 1, launchNonce: randomUUID(), buildId: 'phase-source-test', dataRoot: directory,
            app: { origin: 'http://127.0.0.1:3210', sessionToken: 'a'.repeat(64) }, engine: { origin: 'http://127.0.0.1:3222', apiKey: 'b'.repeat(64) } }
        sent = []
        // Capture the real production turn exactly at its model transport boundary. No model runs.
        vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
            expect(url).toBe(`${runtime.engine.origin}/desktop/foreman/chat`)
            const turn = JSON.parse(String(init.body))
            sent.push(turn)
            return new Response(null, { headers: { 'x-run-id': turn.binding.runId, 'x-session-id': turn.sessionId } })
        }))
    })
    afterEach(async () => { state.db.close(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }) })

    it('previews only public reply text from the active owned turn', async () => {
        const app = await desktopForeman(runtime)
        const id = randomUUID()
        const subscription = new AbortController()
        const events = vi.fn()
        await app.subscribe(chat, subscription.signal, events)
        await expect(app.subscribe({ ...chat, workspaceId: '2' }, subscription.signal, vi.fn())).rejects.toThrow()
        let stream!: ReadableStreamDefaultController<Uint8Array>
        const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller } })
        const push = (chunk: object) => stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`))
        const transport = vi.fn<typeof globalThis.fetch>(async () => new Response(body, {
            headers: { 'x-run-id': id, 'x-session-id': 'original-session', 'content-type': 'text/event-stream' },
        }))
        vi.stubGlobal('fetch', transport)
        const run = { id, agentId: 'foreman', sessionId: 'original-session', status: 'running' } as Awaited<ReturnType<typeof getRun>>
        vi.mocked(getRun).mockResolvedValue(run)
        const userMessage = { id: 'user-fixture', sessionId: 'original-session', role: 'user' as const,
            contentJson: JSON.stringify([{ type: 'text', text: 'Review this fixture' }]), toolCallsJson: null, createdAt: timestamp }
        vi.mocked(getSessionMessages).mockResolvedValue([userMessage])
        try {
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
            await app.send(chat, id, 'Review this fixture')
            const signal = transport.mock.calls[0]?.[1]?.signal
            vi.advanceTimersByTime(31_000)
            vi.useRealTimers()
            expect(signal?.aborted).toBe(false)
            expect((await app.state()).writing).toBe(false)
            push({ type: 'start', messageId: randomUUID() })
            push({ type: 'text-delta', id: 'foreign', delta: 'Do not accept this reply' })
            await new Promise(resolve => setImmediate(resolve))
            expect((await app.state()).writing).toBe(false)
            expect(events).not.toHaveBeenCalled()
            push({ type: 'start', messageId: id })
            push({ type: 'reasoning-delta', id: 'internal', delta: 'fixture-private-reasoning' })
            push({ type: 'tool-input-available', toolCallId: 'fixture-private-tool-id', toolName: 'search_docs', input: { query: 'fixture-private-input' } })
            await vi.waitFor(async () => expect((await app.state()).liveReply).toMatchObject({
                runId: id, text: '', steps: [{ tool: 'search_docs', offset: 0, status: 'running' }],
            }))
            push({ type: 'tool-output-available', toolCallId: 'fixture-private-tool-id', output: 'fixture-private-output', preliminary: true })
            push({ type: 'tool-output-error', toolCallId: 'other-tool-id', errorText: 'fixture-private-error' })
            await new Promise(resolve => setImmediate(resolve))
            expect((await app.state()).liveReply?.steps).toEqual([{ tool: 'search_docs', offset: 0, status: 'running' }])
            push({ type: 'tool-output-available', toolCallId: 'fixture-private-tool-id', output: 'fixture-private-final-output' })
            push({ type: 'text-start', id: 'answer' })
            push({ type: 'text-delta', id: 'answer', delta: 'Visible' })
            push({ type: 'text-delta', id: 'answer', delta: ' ' })
            push({ type: 'text-delta', id: 'answer', delta: 'reply' })
            await vi.waitFor(async () => expect(await app.state()).toMatchObject({
                writing: true, liveReply: { runId: id, text: 'Visible reply', steps: [{ tool: 'search_docs', offset: 0, status: 'done' }] },
            }))
            expect(JSON.stringify(await app.state())).not.toMatch(/fixture-private|Do not accept this reply/)
            await vi.waitFor(() => expect(events).toHaveBeenCalledExactlyOnceWith({ type: 'reply-changed', binding: { ...chat, runId: id, model } }))
            subscription.abort()
            vi.mocked(getRun).mockResolvedValue({ ...run, sessionId: 'foreign-session' })
            expect(await app.state()).toMatchObject({ writing: false, liveReply: null })
            vi.mocked(getRun).mockResolvedValue(run)
            push({ type: 'text-end', id: 'answer' })
            await vi.waitFor(async () => expect((await app.state()).writing).toBe(false))
            push({ type: 'tool-input-start', toolCallId: 'second', toolName: 'agent_files_list' })
            push({ type: 'tool-output-error', toolCallId: 'second', errorText: 'fixture-private-error' })
            push({ type: 'tool-input-start', toolCallId: 'question', toolName: 'ask_user' })
            push({ type: 'tool-input-available', toolCallId: 'question', toolName: 'ask_user', input: { question: 'fixture-private-question' } })
            push({ type: 'text-start', id: 'answer-2' })
            push({ type: 'text-delta', id: 'answer-2', delta: 'Continuing' })
            await vi.waitFor(async () => expect((await app.state()).liveReply?.text).toBe('Visible reply\n\nContinuing'))
            expect((await app.state()).liveReply?.steps).toEqual([
                { tool: 'search_docs', offset: 0, status: 'done' },
                { tool: 'agent_files_list', offset: 'Visible reply'.length, status: 'error' },
            ])
            expect(JSON.stringify(await app.state())).not.toContain('fixture-private')
            push({ type: 'text-delta', id: 'answer-2', delta: 'A'.repeat(DESKTOP_FOREMAN_LIVE_REPLY_LIMIT + 1) })
            await vi.waitFor(async () => expect((await app.state()).liveReply?.text).toHaveLength(DESKTOP_FOREMAN_LIVE_REPLY_LIMIT))
            vi.mocked(getSessionMessages).mockResolvedValue([userMessage, { ...userMessage, id: 'assistant-fixture', role: 'assistant' as const }])
            expect((await app.state()).liveReply).toBeNull()
            vi.mocked(getRun).mockResolvedValue({ ...run, status: 'done', finishedAt: timestamp })
            expect(await app.state()).toMatchObject({ writing: false, liveReply: null })
            app.closeVoiceAdmission()
            expect(signal?.aborted).toBe(true)
            expect(events).toHaveBeenCalledTimes(1)
        } finally { subscription.abort(); vi.useRealTimers(); stream.close() }
    })

    it('reads the context of an exact completed Foreman run and refuses foreign or unrecorded usage', async () => {
        const app = await desktopForeman(runtime)
        const id = randomUUID()
        await app.send(chat, id, 'Review this fixture')
        vi.mocked(getSessionMessages).mockResolvedValue([{ id: 'assistant-fixture', sessionId: 'original-session', role: 'assistant',
            contentJson: JSON.stringify([{ type: 'text', text: 'Synthetic reply' }]), toolCallsJson: null, createdAt: timestamp }])
        const usage = { inputTokens: 12, outputTokens: 8, totalTokens: 20, context: { usedTokens: 50, maxTokens: 200 } }
        const run: Run = { id, agentId: 'foreman', sessionId: 'original-session', status: 'done', stepCount: 1, model: model.model,
            usageJson: JSON.stringify(usage), provider: 'codex', startedAt: timestamp, finishedAt: timestamp, error: null,
            triggerSource: 'chat', triggerSlug: null, costMicros: null, inputTokens: 12, outputTokens: 8, cachedInputTokens: null, reasoningTokens: null, totalTokens: 20 }
        vi.mocked(getRun).mockResolvedValue(run)
        expect((await app.state()).context).toEqual({ model, usage, usedTokens: 50, maxTokens: 200, estimated: false })
        expect(getRun).toHaveBeenCalledWith(expect.anything(), 'foreman', id, { signal: expect.any(AbortSignal) })
        for (const mismatched of [{ sessionId: 'foreign-session' }, { id: randomUUID() }, { model: 'another-model' }, { status: 'cancelled' as const }, { usageJson: '{' }]) {
            vi.mocked(getRun).mockResolvedValue({ ...run, ...mismatched })
            expect((await app.state()).context).toBeNull()
        }
        const billed = { totalTokens: 1200 }
        vi.mocked(getRun).mockResolvedValue({ ...run, usageJson: JSON.stringify(billed) })
        expect((await app.state()).context).toEqual({ model, usage: billed, usedTokens: 1200, maxTokens: 272_000, estimated: true })
        for (const provider of ['claude', 'custom']) {
            vi.mocked(getRun).mockResolvedValue({ ...run, provider, usageJson: JSON.stringify(billed) })
            expect((await app.state()).context).toBeNull()
        }
        vi.mocked(getRun).mockRejectedValue(new Error('Run history temporarily unavailable'))
        expect(await app.state()).toMatchObject({ context: null, messages: [{ id: 'engine-assistant-fixture' }] })
    })

    it('restores only the exact settled failure across reopen without disclosing provider details', async () => {
        const app = await desktopForeman(runtime)
        const id = randomUUID()
        await app.send(chat, id, 'Review this fixture')
        vi.mocked(getSessionMessages).mockResolvedValue([{ id: 'user-fixture', sessionId: 'original-session', role: 'user',
            contentJson: JSON.stringify([{ type: 'text', text: 'Review this fixture' }]), toolCallsJson: null, createdAt: timestamp, foremanRunId: id }])
        const failed = { id, agentId: 'foreman', sessionId: 'original-session', status: 'error',
            finishedAt: timestamp, error: '401 Unauthorized fixture-private-provider-detail' } as Awaited<ReturnType<typeof getRun>>
        vi.mocked(getRun).mockResolvedValue(failed)
        const result = await app.state()
        const failure = { kind: 'unauthorized', connectionId: model.connectionId }
        expect(result).toMatchObject({ runFailure: failure, context: null, messages: [{ id: 'engine-user-fixture' }] })
        expect(JSON.stringify(result)).not.toContain('fixture-private-provider-detail')

        state.db.close()
        state.db = open()
        const reopened = await desktopForeman({ ...runtime, launchNonce: randomUUID() })
        expect((await reopened.state()).runFailure).toEqual(failure)
        expect(sent).toHaveLength(1)

        for (const mismatch of [{ sessionId: 'foreign-session' }, { id: randomUUID() }, { agentId: 'another-coworker' },
            { finishedAt: null }, { status: 'cancelled' as const }]) {
            vi.mocked(getRun).mockResolvedValue({ ...failed, ...mismatch })
            expect((await reopened.state()).runFailure).toBeNull()
        }
        vi.mocked(getRun).mockResolvedValue({ ...failed, error: 'fixture-private-provider-detail' })
        expect((await reopened.state()).runFailure).toEqual({ ...failure, kind: 'generic' })
        vi.mocked(getRun).mockResolvedValue(failed)

        const next = randomUUID()
        vi.mocked(fetch).mockRejectedValueOnce(new Error('Lost response to next request'))
        await expect(reopened.send(chat, next, 'Try the replacement connection')).rejects.toThrow('Lost response to next request')
        expect((await reopened.state()).runFailure).toBeNull()
        vi.mocked(getRun).mockImplementation(async (_engine, _agent, runId) => runId === id ? failed
            : { ...failed, id: runId, status: 'done', error: null })
        await expect(reopened.send(chat, next, 'Try the replacement connection')).resolves.toEqual({ runId: next })
        expect((await reopened.state()).runFailure).toBeNull()
    })

    it('keeps a selected model on the chat and follows the workspace on every turn after clearing it', async () => {
        const app = await desktopForeman(runtime)
        const { connections } = await readDesktopProviders(runtime)
        const workspace = { connectionId: model.connectionId, model: 'workspace-fixture' }
        vi.mocked(desktopModel).mockResolvedValue({ connections, connection: connections[0]!, model: workspace.model, default: workspace })
        expect(await app.setModel(chat, model, workspace)).toEqual({ model: workspace })
        await app.send(chat, randomUUID(), 'Use the selected model')
        expect(sent.at(-1)?.binding.model).toEqual(workspace)
        expect(await app.setModel(chat, workspace, null)).toEqual({ model: null })
        const first = randomUUID()
        await app.send(chat, first, 'Follow the workspace')
        expect(sent.at(-1)?.binding.model).toEqual(workspace)
        expect((await app.state()).model).toBeNull()
        vi.mocked(desktopModel).mockResolvedValue({ connections, connection: connections[0]!, model: model.model, default: model })
        await app.send(chat, first, 'Follow the workspace')
        expect(sent.at(-1)?.binding.model).toEqual(workspace)
        await app.send(chat, randomUUID(), 'Follow the changed workspace default')
        expect(sent.at(-1)?.binding.model).toEqual(model)
        expect((await app.state()).model).toBeNull()
    })

    it('refuses foreign, stale, unavailable and in-flight model changes without overwriting the selection', async () => {
        const app = await desktopForeman(runtime)
        const workspace = { connectionId: model.connectionId, model: 'workspace-fixture' }
        await expect(app.setModel({ ...chat, workspaceId: '2' }, model, workspace)).rejects.toMatchObject({ status: 404 })
        await expect(app.setModel(chat, null, workspace)).rejects.toMatchObject({ status: 409 })
        await expect(app.setModel(chat, model, { ...model, model: 'unavailable' })).rejects.toMatchObject({ status: 400 })
        await app.send(chat, randomUUID(), 'Already running')
        vi.mocked(getRun).mockImplementation(async (_engine, _agent, id) => ({ id, agentId: 'foreman', sessionId: 'original-session', status: 'running' }) as Awaited<ReturnType<typeof getRun>>)
        await expect(app.setModel(chat, model, workspace)).rejects.toMatchObject({ status: 409 })
        expect((await app.state()).model).toEqual(model)
    })

    async function authenticatedStarterAction() {
        const runtimeFile = join(directory, 'runtime.json')
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        vi.stubEnv('RERUN_DESKTOP_DATA_DIR', directory)
        vi.stubEnv('RERUN_DESKTOP_RUNTIME_FILE', runtimeFile)
        await writeFile(runtimeFile, JSON.stringify(runtime), { mode: 0o600 })
        return (scope: DesktopForemanChatRef, input: unknown, authenticated = true) => foremanAction(new Request(runtime.app.origin + '/api/desktop/foreman', {
            method: 'POST',
            headers: { host: new URL(runtime.app.origin).host, origin: runtime.app.origin,
                ...(authenticated && { cookie: 'rerun-desktop-session=' + runtime.app.sessionToken }) },
            body: JSON.stringify({ action: 'starter', chat: scope, input }),
        }))
    }

    async function prepareStarter() {
        const app = await desktopForeman(runtime)
        const intake = createDesktopForemanIntakeBinding(runtime, app)
        const saved = await intake.save({ chat, requestId: randomUUID(), baseRevision: 0, stepIndex: 2,
            draft: { ...EMPTY_DRAFT, companyUrl: answers.companyUrl, industry: answers.industry, position: answers.position, firstName: answers.firstName },
            decidedIndustry: null, knownFirstName: null })
        vi.mocked(request).mockImplementation(async (_engine, path, _init, parse) => parse(path === '/desktop/templates' ? {
            templates: [{ templateId: 'a'.repeat(32), revision: 'b'.repeat(64), title: 'Fixture support', status: 'captured', coworkerCount: 1, capturedAt: timestamp }],
        } : { question: null }))
        const receipt = await intake.complete({ chat, requestId: randomUUID(), expectedRevision: saved.session.revision, answers })
        expect(receipt).toMatchObject({ state: 'acknowledged', followUp: { conversationId: 'original-session', runId: null } })
        const prepared = (await app.starterOffers.read(chat, receipt.requestId))!
        expect((await app.state()).starter).toMatchObject({ offerId: prepared.id, decision: null })
        expect(sent).toEqual([])
        return { prepared, receipt }
    }

    it('resumes the exact saved starter answer once after a lost response and refuses it after Stop', async () => {
        const app = await desktopForeman(runtime)
        const { prepared, receipt } = await prepareStarter()
        const choice = { offerId: prepared.id, digest: prepared.digest, intakeRequestId: receipt.requestId,
            choice: { kind: 'text' as const, text: 'Design a support coworker' } }
        let answerFromApp = await authenticatedStarterAction()
        expect((await answerFromApp(chat, choice, false)).status).toBe(401)
        expect((await answerFromApp({ ...chat, workspaceId: '2' }, choice)).status).toBe(404)
        expect((await answerFromApp(chat, { ...choice, choice: { kind: 'cards', chosen: ['f'.repeat(32)] } })).status).toBe(409)
        expect((await state.db.execute('SELECT offer_id FROM desktop_foreman_local_starter_decisions')).rows).toEqual([])
        const transport = vi.mocked(fetch).getMockImplementation()!
        vi.mocked(fetch).mockImplementationOnce(async (url, init) => {
            await transport(url, init)
            throw new Error('Lost starter response')
        })
        await expect(app.answerStarter(chat, choice, AbortSignal.timeout(5000))).rejects.toThrow('Lost starter response')
        expect(sent).toEqual([expect.objectContaining({ text: choice.choice.text, replayOnly: false,
            binding: expect.objectContaining({ ...chat, runId: prepared.id }), sessionId: 'original-session' })])
        expect(sent[0]).not.toHaveProperty('starterOfferId')
        expect((await app.state()).starter?.decision).toMatchObject({ choice: choice.choice, settled: false })

        state.db.close()
        state.db = open()
        runtime = { ...runtime, launchNonce: randomUUID() }
        answerFromApp = await authenticatedStarterAction()
        const reopened = await desktopForeman(runtime)
        await expect(reopened.send(chat, prepared.id, choice.choice.text, model)).rejects.toMatchObject({ status: 409 })
        await expect(reopened.answerStarter(chat, { ...choice, choice: { kind: 'text', text: 'Another job' } }, AbortSignal.timeout(5000))).rejects.toMatchObject({ status: 409 })
        const accepted = await answerFromApp(chat, choice)
        expect(accepted.status).toBe(200)
        expect(await accepted.json()).toEqual({ runId: prepared.id })
        expect((await reopened.state()).starter?.decision).toMatchObject({ choice: choice.choice, settled: true })
        await expect(reopened.answerStarter(chat, choice, AbortSignal.timeout(5000))).resolves.toEqual({ runId: prepared.id })
        expect(sent).toHaveLength(2)
        expect(sent[1]).toMatchObject({ replayOnly: true, binding: { runId: prepared.id } })
        expect((await state.db.execute('SELECT request_id FROM desktop_foreman_turns')).rows).toEqual([{ request_id: prepared.id }])
        vi.mocked(getRun).mockResolvedValueOnce({ id: prepared.id, agentId: 'foreman', sessionId: 'original-session', status: 'running' } as Awaited<ReturnType<typeof getRun>>)
        await reopened.stop(chat)
        expect(cancelRun).toHaveBeenCalledWith(expect.anything(), 'foreman', prepared.id)
        await expect(reopened.answerStarter(chat, choice, AbortSignal.timeout(5000))).rejects.toMatchObject({ status: 409 })
        expect(sent).toHaveLength(2)
    })

    it.each(['confirm', 'stop', 'replaced template'] as const)('preserves an exact starter plan across reopen and handles %s', async outcome => {
        const validate = vi.fn(async () => {})
        const ensureBox = vi.fn(async () => ({ spaceId: randomUUID() }))
        const install = vi.fn(async () => ({ agentIds: [randomUUID()] }))
        state.creation = { assertTemplateRevision: validate, ensureBox, installTemplate: install }
        const { prepared, receipt } = await prepareStarter()
        const card = prepared.cards[0]!
        const input = { offerId: prepared.id, intakeRequestId: receipt.requestId, digest: prepared.digest,
            choice: { kind: 'cards' as const, chosen: [card.templateId] } }
        const answerFromApp = await authenticatedStarterAction()
        const response = await answerFromApp(chat, input)
        expect(response.status).toBe(200)
        const shown = await response.json() as { revision: unknown }
        const revision = foremanRevisionSchema.parse(shown.revision)
        expect(shown.revision).toMatchObject({ starter: { offerId: prepared.id, digest: prepared.digest }, runId: null, toolCallId: null, model: null,
            state: 'shown', plan: { items: [{ kind: 'template', templateId: card.templateId, templateRevision: card.revision }] } })
        const projected = projectPlanCard(revisionToTrustedSnapshot(revision))
        expect(projected).toMatchObject({ revisionId: revision.revisionId, decision: null, streaming: false })
        expect(projected.view?.groups[0]?.items[0]?.name).toBe(card.title)
        expect(ensureBox).not.toHaveBeenCalled()
        expect(install).not.toHaveBeenCalled()
        expect(sent).toEqual([])

        state.db.close()
        state.db = open()
        const reopened = await desktopForeman({ ...runtime, launchNonce: randomUUID() })
        expect((await reopened.core.readView(chat)).revisions).toEqual([shown.revision])
        await expect(reopened.answerStarter(chat, input, AbortSignal.timeout(5000))).resolves.toEqual(shown)
        const confirmation = { decision: 'confirm', requestId: randomUUID(), chat, planId: revision.planId, revisionId: revision.revisionId, digest: revision.digest }
        if (outcome === 'stop') {
            await reopened.stop(chat)
            expect((await reopened.core.readView(chat)).revisions[0]?.state).toBe('superseded')
            await expect(reopened.core.decide(confirmation)).rejects.toMatchObject({ code: 'stale_revision' })
            expect(ensureBox).not.toHaveBeenCalled()
            expect(install).not.toHaveBeenCalled()
        } else {
            if (outcome === 'replaced template') validate.mockRejectedValueOnce(new Error('Selected template revision changed.'))
            const confirmed = await reopened.core.decide(confirmation)
            await reopened.core.runBuild(confirmed.buildId!)
            expect(validate).toHaveBeenCalledWith(card.templateId, card.revision)
            if (outcome === 'replaced template') {
                expect((await reopened.core.readView(chat)).build).toMatchObject({ state: 'failed', items: [{ failure: 'template_failed' }] })
                expect(ensureBox).not.toHaveBeenCalled()
                expect(install).not.toHaveBeenCalled()
            } else {
                expect((await reopened.core.readView(chat)).build?.state).toBe('completed')
                expect(install).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ templateId: card.templateId, templateRevision: card.revision }))
            }
        }
        expect(sent).toEqual([])
    })

    it('reserves an answer for the exact completed question and reconciles a lost acknowledgement without another send', async () => {
        const guard = { runId: randomUUID(), sourceMessageId: 'question-message', toolCallId: 'ask-choice', digest: 'a'.repeat(64) }
        const app = await desktopForeman(runtime)
        const sourceModel = { ...model, model: 'workspace-fixture' }
        await app.send(chat, guard.runId, 'Ask a color', sourceModel)
        expect(sent[0]?.binding.model).toEqual(sourceModel)
        sent = []
        vi.mocked(request).mockImplementation(async (_engine, _path, _init, parse) =>
            parse({ question: { guard, questions: [{ question: 'Choose a color', options: ['Red', 'Blue'] }] } }))
        const question = (await app.state()).question!
        const answer = { action: 'answer' as const, requestId: randomUUID(), questionId: question.id, answers: [['Blue']] }
        await expect(app.send(chat, randomUUID(), 'Bypass question', model)).rejects.toMatchObject({ status: 409 })
        await expect(app.answerQuestion(chat, { ...answer, questionId: 'b'.repeat(64) })).rejects.toMatchObject({ status: 409 })
        expect(sent).toHaveLength(0)

        const transport = vi.mocked(fetch).getMockImplementation()!
        vi.mocked(fetch).mockRejectedValueOnce(new Error('Lost answer response'))
        await expect(app.answerQuestion(chat, answer)).rejects.toThrow('Lost answer response')
        expect((await app.state()).question?.attempt).toEqual({ action: 'answer', requestId: answer.requestId, answers: [['Blue']] })
        await expect(app.answerQuestion(chat, { ...answer, requestId: randomUUID() })).rejects.toMatchObject({ status: 409 })
        await expect(app.answerQuestion(chat, { ...answer, answers: [['Red']] })).rejects.toMatchObject({ status: 409 })
        vi.mocked(fetch).mockImplementation(transport)
        await expect(app.answerQuestion(chat, answer)).resolves.toEqual({ runId: answer.requestId })
        expect(sent).toEqual([expect.objectContaining({ question: guard, replayOnly: true, text: expect.stringContaining('Blue') })])
        expect(sent[0]?.binding.model).toEqual(sourceModel)
        expect(sent[0]).not.toHaveProperty('answerIntent')
        vi.mocked(request).mockImplementation(async (_engine, _path, _init, parse) => parse({ question: null }))
        expect((await app.state()).question).toBeNull()
    })

    it('keeps a batch of decisions tied to its producing run across a lost response and database reopen', async () => {
        const guard = { runId: randomUUID(), sourceMessageId: 'approval-message', toolCallId: 'review-actions', digest: 'a'.repeat(64) }
        const app = await desktopForeman(runtime)
        const sourceModel = { ...model, model: 'workspace-fixture' }
        await app.send(chat, guard.runId, 'Review two synthetic actions', sourceModel)
        sent = []
        const approvals = [{ action: 'Open the sample' }, { action: 'Archive the sample' }]
        vi.mocked(request).mockImplementation(async (_engine, _path, _init, parse) => parse({ question: null, approval: { guard, approvals } }))
        const approval = (await app.state()).approval!
        expect(approval.approvals).toEqual(approvals)
        const decisions = [{ decision: 'approved' }, { decision: 'declined', note: 'Keep this one' }] as const
        const input = { approvalId: approval.id, requestId: randomUUID(), decisions: [...decisions] }
        await expect(app.send(chat, randomUUID(), 'Bypass the card')).rejects.toMatchObject({ status: 409 })
        await expect(app.decideApproval(chat, { ...input, approvalId: 'b'.repeat(64) })).rejects.toMatchObject({ status: 409 })
        await expect(app.decideApproval(chat, { ...input, decisions: [decisions[0]] })).rejects.toMatchObject({ status: 400 })
        expect(sent).toHaveLength(0)

        vi.mocked(fetch).mockRejectedValueOnce(new Error('Lost approval response'))
        await expect(app.decideApproval(chat, input)).rejects.toThrow('Lost approval response')
        state.db.close()
        state.db = open()
        const reopened = await desktopForeman({ ...runtime, launchNonce: randomUUID() })
        expect((await reopened.state()).approval?.attempt).toEqual({ requestId: input.requestId, decisions })
        await expect(reopened.decideApproval(chat, { ...input, requestId: randomUUID() })).rejects.toMatchObject({ status: 409 })
        await expect(reopened.decideApproval(chat, { ...input, decisions: [decisions[0], decisions[0]] })).rejects.toMatchObject({ status: 409 })
        await expect(reopened.decideApproval(chat, input)).resolves.toEqual({ runId: input.requestId })
        expect(sent).toEqual([expect.objectContaining({ approval: guard, replayOnly: true, text: expect.stringContaining('Keep this one') })])
        expect(sent[0]?.binding.model).toEqual(sourceModel)
        expect(sent[0]).not.toHaveProperty('approvalIntent')
        vi.mocked(request).mockImplementation(async (_engine, _path, _init, parse) => parse({ question: null, approval: null }))
        expect((await reopened.state()).approval).toBeNull()
    })

    it('first exact pending intake sends the plan brief before model admission and returns plan after acknowledgement', async () => {
        const app = await desktopForeman(runtime)
        const intake = createDesktopForemanIntakeBinding(runtime, app)
        const saved = await intake.save({ chat, requestId: randomUUID(), baseRevision: 0, stepIndex: 2,
            draft: { ...EMPTY_DRAFT, companyUrl: answers.companyUrl, industry: answers.industry, position: answers.position, firstName: answers.firstName }, decidedIndustry: null, knownFirstName: null })
        const receipt = await intake.complete({ chat, requestId: randomUUID(), expectedRevision: saved.session.revision, answers })
        expect(receipt.state).toBe('acknowledged')
        expect(sent).toHaveLength(1)
        expect(sent[0]!.brief.instructions).toContain(planLine)
        expect(sent[0]!.brief.instructions).not.toContain(discoverLine)
        expect(sent[0]!.brief.instructions).toContain(JSON.stringify(answers))
        expect((await app.core.readView(chat)).phase).toBe('plan')
        expect((await app.state()).view.phase).toBe('plan')
    })

    it('Stop during starter preparation finishes intake without showing an offer or sending the fallback turn', async () => {
        const app = await desktopForeman(runtime)
        const intake = createDesktopForemanIntakeBinding(runtime, app)
        const saved = await intake.save({ chat, requestId: randomUUID(), baseRevision: 0, stepIndex: 2,
            draft: { ...EMPTY_DRAFT, companyUrl: answers.companyUrl, industry: answers.industry, position: answers.position, firstName: answers.firstName },
            decidedIndustry: null, knownFirstName: null })
        vi.mocked(request).mockImplementation(async (_engine, path, _init, parse) => {
            if (path !== '/desktop/templates') return parse({ question: null })
            await app.stop(chat)
            return parse({ templates: [{ templateId: 'a'.repeat(32), revision: 'b'.repeat(64), title: 'Fixture support', status: 'captured', coworkerCount: 1, capturedAt: timestamp }] })
        })
        const complete = { chat, requestId: randomUUID(), expectedRevision: saved.session.revision, answers }
        const first = await intake.complete(complete)
        expect(first).toMatchObject({ state: 'acknowledged', followUp: { conversationId: 'original-session', runId: null } })
        expect(await intake.complete(complete)).toEqual(first)
        expect((await app.state()).starter).toBeNull()
        expect(sent).toEqual([])
    })

    it('a poll before completion ACK cannot cache the generated kickoff for the ordinary chat layer', async () => {
        const app = await desktopForeman(runtime), intake = createDesktopForemanIntakeBinding(runtime, app)
        const saved = await intake.save({ chat, requestId: randomUUID(), baseRevision: 0, stepIndex: 2,
            draft: { ...EMPTY_DRAFT, companyUrl: answers.companyUrl, industry: answers.industry, position: answers.position, firstName: answers.firstName }, decidedIndustry: null, knownFirstName: null })
        let release!: () => void
        const gate = new Promise<void>(resolve => { release = resolve })
        vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
            const turn = JSON.parse(String(init.body)); sent.push(turn)
            await gate
            return new Response(null, { headers: { 'x-run-id': turn.binding.runId, 'x-session-id': turn.sessionId } })
        }))
        const requestId = randomUUID()
        const completion = intake.complete({ chat, requestId, expectedRevision: saved.session.revision, answers })
        await vi.waitFor(() => expect(sent).toHaveLength(1))
        const kickoff = { id: 'trusted-generated-row', sessionId: 'original-session', role: 'user' as const, contentJson: JSON.stringify(sent[0]!.text), toolCallsJson: null, createdAt: timestamp }
        vi.mocked(getSessionMessages).mockResolvedValue([kickoff, { ...kickoff, id: 'genuine-same-text-row' }])
        vi.mocked(getRun).mockResolvedValue({ id: requestId, agentId: 'foreman', sessionId: 'original-session', status: 'done', model: model.model, queuedUserMessageId: kickoff.id } as Awaited<ReturnType<typeof getRun>>)
        try {
            const pending = await app.state()
            expect(pending.view.phase).toBe('discover')
            expect(pending.messages.map(message => message.id)).toEqual(['engine-genuine-same-text-row'])
        } finally { release(); await completion }
        expect((await app.state()).messages.map(message => message.id)).toEqual(['engine-genuine-same-text-row'])
        expect((await app.state()).view.phase).toBe('plan')
        expect(sent).toHaveLength(1)
    })

    it('restored acknowledged intake advances both production view and subsequent briefs without a new kickoff', async () => {
        const original = await desktopForeman(runtime)
        expect((await original.core.readView(chat)).phase).toBe('discover')
        await seedReceipt('acknowledged')
        state.db.close(); state.db = open()
        runtime = { ...runtime, launchNonce: randomUUID() }
        const restored = await desktopForeman(runtime)
        expect((await restored.core.readView(chat)).phase).toBe('plan')
        expect((await restored.state()).view.phase).toBe('plan')
        expect(sent).toHaveLength(0)
        await restored.send(chat, randomUUID(), 'Help me plan the team.')
        expect(sent[0]!.brief.instructions).toContain(planLine)
        expect(sent[0]!.brief.instructions).not.toContain(discoverLine)
    })

    it.each(['pending', 'uncertain', 'failed', 'unavailable'] as const)('ordinary turns and restored views cannot use an unacknowledged %s receipt', async completionState => {
        await seedReceipt(completionState)
        const app = await desktopForeman(runtime)
        expect((await app.core.readView(chat)).phase).toBe('discover')
        expect((await app.state()).view.phase).toBe('discover')
        await app.send(chat, randomUUID(), 'An ordinary message with its own request ID.')
        expect(sent[0]!.brief.instructions).toContain(discoverLine)
        expect(sent[0]!.brief.instructions).not.toContain(planLine)
        expect(sent[0]!.brief.instructions).not.toContain(JSON.stringify(answers))
    })

    it('cannot use acknowledged company answers from another workspace or chat', async () => {
        await seedReceipt('acknowledged', { ...chat, workspaceId: '2' })
        await seedReceipt('acknowledged', { ...chat, chatId: 'fmc_anotherphase01' })
        const app = await desktopForeman(runtime)
        expect((await app.core.readView(chat)).phase).toBe('discover')
        await expect(app.core.readView({ ...chat, workspaceId: '2' })).rejects.toMatchObject({ code: 'not_found' })
        await app.send(chat, randomUUID(), 'Use this conversation only.')
        expect(sent[0]!.brief.instructions).toContain(discoverLine)
        expect(sent[0]!.brief.instructions).not.toContain(JSON.stringify(answers))
    })

    it('an ordinary message cannot borrow a pending profile by reusing its reserved request ID', async () => {
        const receipt = await seedReceipt('pending')
        const app = await desktopForeman(runtime)
        await app.send(chat, receipt.requestId, 'This is not the canonical intake kickoff body.')
        expect(sent[0]!.brief.instructions).toContain(discoverLine)
        expect(sent[0]!.brief.instructions).not.toContain(planLine)
        expect(sent[0]!.brief.instructions).not.toContain(JSON.stringify(answers))
        expect((await app.core.readView(chat)).phase).toBe('discover')
    })

    it('preserves an existing plan phase independently of company intake', async () => {
        const app = await desktopForeman(runtime)
        const revision: DesktopForemanRevision = {
            planId: 'fmp_existingphase01', revisionId: 'fmr_existingphase01', revision: 1, digest: 'a'.repeat(64), chat,
            runId: randomUUID(), toolCallId: 'existing-plan-call', model, state: 'shown', shownAt: timestamp,
            plan: { title: 'Existing plan', boxes: [{ key: 'box-0', name: 'Sales' }], items: [{ kind: 'agent', key: 'item-0', boxKey: 'box-0', name: 'Outreach', role: 'Draft outreach' }] },
        }
        await state.db.execute({ sql: 'INSERT INTO desktop_foreman_revisions(revision_id,workspace_id,chat_id,plan_id,revision,run_id,tool_call_id,digest,state,body) VALUES(?,?,?,?,?,?,?,?,?,?)', args: [revision.revisionId, chat.workspaceId, chat.chatId, revision.planId, 1, revision.runId, revision.toolCallId, revision.digest, revision.state, JSON.stringify(revision)] })
        expect((await app.core.readView(chat)).phase).toBe('plan')
        await app.send(chat, randomUUID(), 'Revise the existing plan.')
        expect(sent[0]!.brief.instructions).toContain(planLine)
        expect(sent[0]!.brief.instructions).not.toContain(JSON.stringify(answers))
    })

    it('preserves the build view and existing build-to-companion brief despite acknowledged intake', async () => {
        await seedReceipt('acknowledged')
        const app = await desktopForeman(runtime)
        const build: DesktopForemanBuild = {
            buildId: 'fmb_buildphase01', decisionId: 'fmd_buildphase01', revisionId: 'fmr_buildphase01', state: 'stopped', boxes: [], items: [], leadItemKey: null,
            setup: { state: 'not_started', agentId: null, sessionId: null, error: null }, startedAt: timestamp, updatedAt: timestamp,
        }
        await state.db.execute({ sql: 'INSERT INTO desktop_foreman_builds(build_id,chat_id,decision_id,version,intents,body) VALUES(?,?,?,0,?,?)', args: [build.buildId, chat.chatId, build.decisionId, JSON.stringify({ boxes: {}, items: {}, setup: null }), JSON.stringify(build)] })
        expect((await app.core.readView(chat)).phase).toBe('build')
        expect((await app.state()).view.phase).toBe('build')
        await app.send(chat, randomUUID(), 'What is the current team doing?')
        expect(sent[0]!.brief.instructions).toContain('Their team is built: help them run it.')
        expect(sent[0]!.brief.instructions).not.toContain(planLine)
        expect(sent[0]!.brief.instructions).not.toContain(discoverLine)
    })

    it('does not regress an existing companion workspace to plan', async () => {
        state.agentCount = 1
        await seedReceipt('acknowledged')
        const app = await desktopForeman(runtime)
        expect((await app.core.readView(chat)).phase).toBe('companion')
        await app.send(chat, randomUUID(), 'Help with the existing team.')
        expect(sent[0]!.brief.instructions).toContain('Their team is built: help them run it.')
        expect(sent[0]!.brief.instructions).not.toContain(planLine)
    })
})
