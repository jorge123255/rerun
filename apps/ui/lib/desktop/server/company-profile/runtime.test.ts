import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
    EMPTY_DRAFT,
    type CompanyBriefModelRef,
    type DesktopCompanyProfileAttempt,
    type DesktopCompanyProfileCanonicalContext,
    type DesktopCompanyProfileEngineOutcome,
    type DesktopCompanyProfileEvidence,
    type DesktopForemanIntakeSession,
} from '@rerun/contracts'
import { assertDesktopCompanyProfileIdentity, desktopCompanyProfileIdentities } from './identity'
import { createDesktopCompanyProfileService, type DesktopCompanyProfileServicePorts } from './service'
import { createMemoryDesktopCompanyProfileStore } from './store'

const model: CompanyBriefModelRef = { connectionId: 'selected', provider: 'codex', model: 'purpose-model', source: 'workspace', agentId: null }
const chat = { workspaceId: 'ws-1', chatId: 'fmc_runtime1' }
const baseSession: DesktopForemanIntakeSession = {
    chat, revision: 1, stepIndex: 0,
    draft: { ...EMPTY_DRAFT, companyUrl: 'acme.example', position: 'Founder', firstName: 'Ada' },
    decidedIndustry: null, knownFirstName: null, updatedAt: '2026-11-06T00:00:00.000Z',
}
const evidence: DesktopCompanyProfileEvidence = {
    id: 'stack:name', field: 'name', source: 'stack', url: 'https://acme.example/', fetchedAt: '2026-11-06T00:00:00.000Z', via: 'public-fetch', status: 200,
    passage: 'Acme makes quiet kettles for small hotels.',
}

function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(done => { resolve = done })
    return { promise, resolve }
}

function fixture(overrides?: {
    session?: DesktopForemanIntakeSession
    decide?: DesktopCompanyProfileServicePorts['engine']['decide']
    enrich?: DesktopCompanyProfileServicePorts['engine']['enrich']
    models?: DesktopCompanyProfileServicePorts['models']
}) {
    const context: DesktopCompanyProfileCanonicalContext = { session: overrides?.session ?? baseSession, accepted: null, discovery: null }
    const calls = { decide: 0, enrich: 0, collect: 0, actor: 0 }
    const store = createMemoryDesktopCompanyProfileStore()
    const ports: DesktopCompanyProfileServicePorts = {
        store,
        canonical: {
            read: async () => context,
            require: async (identity, kind) => {
                assertDesktopCompanyProfileIdentity(context, identity, kind)
                return context
            },
        },
        models: overrides?.models ?? { decision: async () => model, profile: async () => model },
        engine: {
            decide: async () => { calls.decide++; return { status: 'succeeded', decision: { industry: 'ecommerce', confidence: 0.9, source: 'inference' }, inference: null } },
            enrich: async () => {
                calls.enrich++
                return {
                    status: 'succeeded', decision: null,
                    inference: {
                        name: { value: 'Acme', evidenceId: evidence.id, passage: 'Acme' },
                        description: { value: 'Quiet kettles for hotels.', evidenceId: evidence.id, passage: 'quiet kettles for small hotels' },
                        offering: { value: 'Quiet kettles', evidenceId: evidence.id, passage: 'quiet kettles' },
                        audience: { value: 'Small hotels', evidenceId: evidence.id, passage: 'small hotels' },
                        industry: { industry: 'ecommerce', confidence: 0.9, evidenceId: evidence.id, passage: 'kettles' },
                    },
                }
            },
        },
        collector: async ({ onEvent }) => {
            calls.collect++
            onEvent({ type: 'pending', source: 'stack' })
            onEvent({ type: 'settled', source: 'stack', status: 'found', reason: 'found' })
            return { evidence: [evidence] }
        },
        actor: { readKnownFirstName: async () => { calls.actor++; return 'Grace' } },
        now: () => '2026-11-06T00:00:00.000Z',
    }
    if (overrides?.decide) ports.engine.decide = overrides.decide
    if (overrides?.enrich) ports.engine.enrich = overrides.enrich
    const service = createDesktopCompanyProfileService(ports)
    return { service, store, context, calls }
}

describe('company profile runtime identity and replay', () => {
    it('replays a saved industry success without a duplicate request', async () => {
        const { service, calls } = fixture()
        const identity = desktopCompanyProfileIdentities(baseSession).decision!
        const input = { requestId: randomUUID(), identity }
        const first = await service.decide(input)
        const replay = await service.decide(input)
        expect(first).toMatchObject({ status: 'succeeded', outcome: { decision: { industry: 'ecommerce' } } })
        expect(replay).toEqual(first)
        expect(calls.decide).toBe(1)
        expect((await service.read(chat)).decision).toEqual(first)
    })

    it('does not call inference when a manual industry already wins', async () => {
        const session = { ...baseSession, draft: { ...baseSession.draft, industry: 'legal' as const } }
        const { service, calls } = fixture({ session })
        const attempt = await service.decide({ requestId: randomUUID(), identity: desktopCompanyProfileIdentities(session).decision! })
        expect(attempt.outcome).toMatchObject({ status: 'succeeded', decision: { industry: 'legal', source: 'manual', confidence: 1 } })
        expect(calls.decide).toBe(0)
        expect(attempt.modelCalled).toBe(false)
    })

    it('returns explicit unavailable when the configured purpose model is missing', async () => {
        const { service, calls } = fixture({ models: { decision: async () => null, profile: async () => null } })
        const attempt = await service.decide({ requestId: randomUUID(), identity: desktopCompanyProfileIdentities(baseSession).decision! })
        expect(attempt.outcome).toMatchObject({ status: 'unavailable', reason: 'missing_configuration', correction: { field: 'industry' } })
        expect(calls.decide).toBe(0)
    })

    it('rejects an edited URL after the model answer instead of publishing it', async () => {
        const gate = deferred<DesktopCompanyProfileEngineOutcome>()
        const started = deferred<void>()
        const { service, context } = fixture({ decide: async () => { started.resolve(); return gate.promise } })
        const pending = service.decide({ requestId: randomUUID(), identity: desktopCompanyProfileIdentities(baseSession).decision! })
        await started.promise
        context.session = { ...baseSession, revision: 2, draft: { ...baseSession.draft, companyUrl: 'other.example' } }
        gate.resolve({ status: 'succeeded', decision: { industry: 'saas', confidence: 0.9, source: 'inference' }, inference: null })
        expect((await pending).outcome).toMatchObject({ status: 'stale', decision: null })
    })

    it('fences a newer draft revision even when its text is unchanged', async () => {
        const gate = deferred<DesktopCompanyProfileEngineOutcome>()
        const started = deferred<void>()
        const { service, context } = fixture({ decide: async () => { started.resolve(); return gate.promise } })
        const pending = service.decide({ requestId: randomUUID(), identity: desktopCompanyProfileIdentities(baseSession).decision! })
        await started.promise
        context.session = { ...baseSession, revision: baseSession.revision + 1 }
        gate.resolve({ status: 'succeeded', decision: { industry: 'saas', confidence: 0.9, source: 'inference' }, inference: null })
        expect((await pending).status).toBe('stale')
    })

    it('fences a manual industry selected while inference was running', async () => {
        const gate = deferred<DesktopCompanyProfileEngineOutcome>()
        const started = deferred<void>()
        const { service, context } = fixture({ decide: async () => { started.resolve(); return gate.promise } })
        const pending = service.decide({ requestId: randomUUID(), identity: desktopCompanyProfileIdentities(baseSession).decision! })
        await started.promise
        context.session = { ...baseSession, revision: 2, draft: { ...baseSession.draft, industry: 'legal' } }
        gate.resolve({ status: 'succeeded', decision: { industry: 'saas', confidence: 0.9, source: 'inference' }, inference: null })
        expect((await pending).status).toBe('stale')
        expect((await service.read(chat)).profile.industry).toMatchObject({ value: 'legal', origin: 'manual' })
    })

    it('returns a typed stale outcome when Skip invalidates the website input', async () => {
        const identity = desktopCompanyProfileIdentities(baseSession).decision!
        const session = { ...baseSession, revision: 2, draft: { ...EMPTY_DRAFT, websiteSkipped: true } }
        const { service, calls } = fixture({ session })
        const attempt = await service.decide({ requestId: randomUUID(), identity })
        expect(attempt.outcome).toMatchObject({ status: 'stale', correction: { field: 'industry', preserveOriginalQuestion: true } })
        expect(calls.decide).toBe(0)
    })

    it('keeps cancellation terminal when a late answer arrives', async () => {
        const gate = deferred<DesktopCompanyProfileEngineOutcome>()
        const started = deferred<void>()
        const { service } = fixture({ decide: async () => { started.resolve(); return gate.promise } })
        const requestId = randomUUID()
        const pending = service.decide({ requestId, identity: desktopCompanyProfileIdentities(baseSession).decision! })
        await started.promise
        const cancelled = await service.cancel({ requestId, chat })
        gate.resolve({ status: 'succeeded', decision: { industry: 'saas', confidence: 0.9, source: 'inference' }, inference: null })
        expect((await pending).status).toBe('cancelled')
        expect(cancelled.status).toBe('cancelled')
        expect((await service.decide({ requestId, identity: desktopCompanyProfileIdentities(baseSession).decision! })).status).toBe('cancelled')
    })

    it('marks interrupted work after restart and never restarts it on read', async () => {
        const { service, store, calls } = fixture()
        const identity = desktopCompanyProfileIdentities(baseSession).decision!
        const pending: DesktopCompanyProfileAttempt = {
            contractVersion: 1, requestId: randomUUID(), kind: 'decide', identity, status: 'pending',
            progress: { stage: 'analyzing_evidence', sources: [], updatedAt: '2026-11-06T00:00:00.000Z' },
            outcome: null, evidence: [], modelCalled: true, createdAt: '2026-11-06T00:00:00.000Z', updatedAt: '2026-11-06T00:00:00.000Z',
        }
        await store.insert(pending)
        await service.reconcile()
        expect((await service.read(chat)).decision).toMatchObject({ status: 'error', outcome: { reason: 'interrupted' } })
        expect(calls.decide).toBe(0)
    })

    it('refuses request reuse for another identity', async () => {
        const { service } = fixture()
        const requestId = randomUUID()
        await service.decide({ requestId, identity: desktopCompanyProfileIdentities(baseSession).decision! })
        const other = { ...desktopCompanyProfileIdentities(baseSession).decision!, draftRevision: 99 }
        await expect(service.decide({ requestId, identity: other })).rejects.toMatchObject({ code: 'conflict' })
    })

    it('enriches from confined evidence while preserving manual precedence and replay', async () => {
        const session = { ...baseSession, draft: { ...baseSession.draft, industry: 'legal' as const } }
        const { service, calls } = fixture({ session })
        const input = { requestId: randomUUID(), identity: desktopCompanyProfileIdentities(session).enrichment!, collect: true }
        const attempt = await service.enrich(input)
        expect(attempt).toMatchObject({ status: 'succeeded', modelCalled: true, outcome: { profile: { industry: { value: 'legal', origin: 'manual' }, name: { value: 'Acme', origin: 'inference' } } } })
        expect(calls.collect).toBe(1)
        expect(calls.enrich).toBe(1)
        expect(await service.enrich(input)).toEqual(attempt)
        expect(calls.collect).toBe(1)
        expect(calls.enrich).toBe(1)
    })

    it('fences a workspace switch after an await', async () => {
        const gate = deferred<DesktopCompanyProfileEngineOutcome>()
        const started = deferred<void>()
        const { service, context } = fixture({ decide: async () => { started.resolve(); return gate.promise } })
        const pending = service.decide({ requestId: randomUUID(), identity: desktopCompanyProfileIdentities(baseSession).decision! })
        await started.promise
        context.session = { ...baseSession, chat: { ...chat, workspaceId: 'ws-2' } }
        gate.resolve({ status: 'succeeded', decision: { industry: 'saas', confidence: 0.9, source: 'inference' }, inference: null })
        expect((await pending).status).toBe('stale')
    })

    it('cancels all pending attempts for Stop in the current chat', async () => {
        const gate = deferred<DesktopCompanyProfileEngineOutcome>()
        const started = deferred<void>()
        const { service } = fixture({ decide: async () => { started.resolve(); return gate.promise } })
        const pending = service.decide({ requestId: randomUUID(), identity: desktopCompanyProfileIdentities(baseSession).decision! })
        await started.promise
        const stopped = await service.cancelChat(chat)
        expect(stopped.map(attempt => attempt.status)).toEqual(['cancelled'])
        gate.resolve({ status: 'succeeded', decision: { industry: 'saas', confidence: 0.9, source: 'inference' }, inference: null })
        expect((await pending).status).toBe('cancelled')
    })

    it('drains Quit as cancelled without admitting a late result', async () => {
        const gate = deferred<DesktopCompanyProfileEngineOutcome>()
        const started = deferred<void>()
        const { service } = fixture({ decide: async () => { started.resolve(); return gate.promise } })
        const pending = service.decide({ requestId: randomUUID(), identity: desktopCompanyProfileIdentities(baseSession).decision! })
        await started.promise
        const closing = service.close()
        gate.resolve({ status: 'succeeded', decision: { industry: 'saas', confidence: 0.9, source: 'inference' }, inference: null })
        await closing
        expect((await pending).status).toBe('cancelled')
    })

    it('cannot admit work that resumes from a saved-request read after close', async () => {
        const { service, store, calls } = fixture()
        const gate = deferred<null>()
        vi.spyOn(store, 'get').mockImplementationOnce(() => gate.promise)
        const insert = vi.spyOn(store, 'insert')
        const pending = service.decide({ requestId: randomUUID(), identity: desktopCompanyProfileIdentities(baseSession).decision! })
        const rejected = expect(pending).rejects.toMatchObject({ code: 'closed' })
        await service.close()
        gate.resolve(null)
        await rejected
        expect(insert).not.toHaveBeenCalled()
        expect(calls.decide).toBe(0)
    })

    it('concurrent close callers both wait for the same late inference to drain', async () => {
        const gate = deferred<DesktopCompanyProfileEngineOutcome>(), started = deferred<void>()
        const { service } = fixture({ decide: async () => { started.resolve(); return gate.promise } })
        const pending = service.decide({ requestId: randomUUID(), identity: desktopCompanyProfileIdentities(baseSession).decision! })
        await started.promise
        let finished = 0
        const first = service.close().then(() => { finished++ })
        const second = service.close().then(() => { finished++ })
        await Promise.resolve()
        expect(finished).toBe(0)
        gate.resolve({ status: 'succeeded', decision: { industry: 'saas', confidence: 0.9, source: 'inference' }, inference: null })
        await Promise.all([first, second])
        expect(finished).toBe(2)
        expect((await pending).status).toBe('cancelled')
    })

    it('resolves a trusted name observationally without starting inference', async () => {
        const { service, calls } = fixture()
        const view = await service.read(chat)
        expect(view.knownFirstName).toEqual({ status: 'known', firstName: 'Grace', source: 'local_profile' })
        expect(calls.actor).toBe(1)
        expect(calls.decide).toBe(0)
        expect(calls.enrich).toBe(0)
        expect(calls.collect).toBe(0)
    })
})
