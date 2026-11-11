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
} from '@rerun/contracts'
import type { DesktopRuntime } from '../runtime'
import type { ForemanCreationAuthority } from './authority'

const state = vi.hoisted(() => ({ db: null as unknown as Client, agentCount: 0, creation: {} as Partial<ForemanCreationAuthority> }))
vi.mock('../database', () => ({ openDesktopDatabase: async () => state.db }))
vi.mock('../settings', () => ({
    engineOf: (runtime: DesktopRuntime) => ({ baseUrl: runtime.engine.origin, apiKey: runtime.engine.apiKey }),
    readDesktopProviders: async () => ({ connections: [{ id: 'chosen-local-model', name: 'Chosen model', provider: 'codex', connected: true, models: ['model-for-source-test'], extraModels: [] }] }),
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
import { DESKTOP_FOREMAN_CHAT_SCHEMA } from './chat-store'
import { DESKTOP_FOREMAN_SCHEMA_STATEMENTS } from './store'
import { DESKTOP_FOREMAN_INTAKE_SCHEMA_SQL, fingerprintIntakeAnswers } from '../foreman-intake'
import { createDesktopForemanIntakeBinding } from './intake'
import { initializeDesktopRound41 } from '../round41-schema'
import { POST as foremanAction } from '@/app/api/desktop/foreman/route'
import { projectPlanCard, revisionToTrustedSnapshot } from '@/lib/desktop/foreman-client/plan-view'

const chat = { workspaceId: '1', chatId: 'fmc_phaseprimary01' }
const answers = { companyUrl: 'acme.com', industry: 'saas' as const, decidedIndustry: null, industryLabel: null, position: 'Founder', firstName: 'Ada' }
const model = { connectionId: 'chosen-local-model', model: 'model-for-source-test' }
const planLine = 'This turn is about agreeing on what to build for them.'
const discoverLine = 'the address of their company website, what they do there, and their first name'
const timestamp = '2026-11-06T12:00:00.000Z'

describe('production Foreman intake phase and model brief', () => {
    let directory: string
    let runtime: DesktopRuntime
    let sent: Array<{ text: string; brief: { instructions: string } }>
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
        await state.db.executeMultiple([DESKTOP_FOREMAN_CHAT_SCHEMA, ...DESKTOP_FOREMAN_SCHEMA_STATEMENTS, DESKTOP_FOREMAN_INTAKE_SCHEMA_SQL,
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
        vi.mocked(request).mockImplementation(async (_engine, _path, _init, parse) =>
            parse({ question: { guard, questions: [{ question: 'Choose a color', options: ['Red', 'Blue'] }] } }))
        const app = await desktopForeman(runtime)
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
        expect(sent[0]).not.toHaveProperty('answerIntent')
        vi.mocked(request).mockImplementation(async (_engine, _path, _init, parse) => parse({ question: null }))
        expect((await app.state()).question).toBeNull()
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
