import { createClient, type Client } from '@libsql/client'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    EMPTY_DRAFT,
    type DesktopForemanBuild,
    type DesktopForemanChatRef,
    type DesktopForemanIntakeCompletionReceipt,
    type DesktopForemanRevision,
} from '@rerun/contracts'
import type { DesktopRuntime } from '../runtime'

const state = vi.hoisted(() => ({ db: null as unknown as Client, agentCount: 0 }))
vi.mock('../database', () => ({ openDesktopDatabase: async () => state.db }))
vi.mock('../settings', () => ({
    engineOf: (runtime: DesktopRuntime) => ({ baseUrl: runtime.engine.origin, apiKey: runtime.engine.apiKey }),
    readDesktopProviders: async () => ({ connections: [{ id: 'chosen-local-model', name: 'Chosen model', provider: 'codex', connected: true, models: ['model-for-source-test'], extraModels: [] }] }),
    desktopModel: vi.fn(),
}))
vi.mock('../spaces', () => ({ readDesktopBoardState: async () => ({ spaces: [] }) }))
vi.mock('../store', () => ({ listDesktopAgents: async () => Array.from({ length: state.agentCount }, () => ({ id: 'existing-coworker' })) }))
vi.mock('./creation', () => ({ createDesktopForemanCreationAuthority: async () => ({ creation: {}, setup: {} }) }))
vi.mock('../company-discovery', () => ({
    createCompanyDiscoverySqliteStore: vi.fn(),
    createCompanyDiscoveryRuntime: () => ({ reconcile: async () => {}, close: async () => {} }),
    CompanyDiscoveryError: class extends Error {},
}))
vi.mock('../../../../../engine/src/desktop/company-discovery/index.ts', () => ({ confinedCompanyDns: vi.fn(), confinedCompanyReader: vi.fn(), runCompanyCollectors: vi.fn() }))
vi.mock('@/lib/engine/client', () => ({
    EngineRequestError: class extends Error { constructor(message: string, readonly status: number) { super(message) } },
    getRun: vi.fn(async (_engine: unknown, _agent: string, id: string) => ({ id, agentId: 'foreman', sessionId: 'original-session', status: 'finished' })),
    getSessionMessages: vi.fn(async () => []), cancelRun: vi.fn(),
}))
vi.mock('@/lib/chat/engine-history', () => ({ publicDesktopHistory: (value: unknown) => value, transformEngineMessages: (value: unknown) => value }))
import { desktopForeman } from './binding'
import { DESKTOP_FOREMAN_CHAT_SCHEMA } from './chat-store'
import { DESKTOP_FOREMAN_SCHEMA_STATEMENTS } from './store'
import { DESKTOP_FOREMAN_INTAKE_SCHEMA_SQL, fingerprintIntakeAnswers } from '../foreman-intake'
import { createDesktopForemanIntakeBinding } from './intake'

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
        state.agentCount = 0
        directory = await mkdtemp(join(tmpdir(), 'rerun-intake-phase-'))
        state.db = open()
        await state.db.executeMultiple([DESKTOP_FOREMAN_CHAT_SCHEMA, ...DESKTOP_FOREMAN_SCHEMA_STATEMENTS, DESKTOP_FOREMAN_INTAKE_SCHEMA_SQL,
            'CREATE TABLE desktop_workspace(id INTEGER PRIMARY KEY,name TEXT); INSERT INTO desktop_workspace VALUES(1,\'Source test workspace\');'].join(';'))
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
    afterEach(async () => { state.db.close(); vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }) })

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
