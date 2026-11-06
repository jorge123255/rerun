import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { emptyCompanyDiscoverySnapshot, COMPANY_BRIEF_NO_SOURCES, type CompanyBriefModelRef, type CompanyBriefSynthesizeInput, type DesktopCompanyDiscoverySnapshot } from '@rerun/contracts'
import type { CompanyBriefBrain } from './brain.js'
import { createDesktopCompanyBriefRouter } from './router.js'
import { companyBriefSourceRevision } from './revision.js'
import { createCompanyBriefService, type CompanyBriefService } from './service.js'

const model: CompanyBriefModelRef = { connectionId: 'conn-1', provider: 'openai', model: 'gpt-test', source: 'workspace', agentId: null }
const workspaceId = 'workspace-1'
const chatId = 'fmc_chat0001'
const otherChat = 'fmc_chat0002'

const identity: DesktopCompanyDiscoverySnapshot['findings'][number] = {
    kind: 'identity', source: 'site', attribution: { url: 'https://acme.example', fetchedAt: '2026-01-01T00:00:00.000Z', via: 'public-fetch' },
    name: 'Acme', oneLiner: 'Acme sells widgets.', logoUrl: null, domain: 'acme.example',
}

function snapshot(patch: Partial<DesktopCompanyDiscoverySnapshot> = {}): DesktopCompanyDiscoverySnapshot {
    return {
        ...emptyCompanyDiscoverySnapshot({ discoveryId: 'fmx_disc0001', workspaceId, chatId, runId: 'run-1', url: 'https://acme.example', domain: 'acme.example', startedAt: '2026-01-01T00:00:00.000Z' }),
        status: 'done', pending: [], unavailable: ['search', 'registry', 'linkedinCompany'], findings: [identity], ...patch,
    }
}

function input(run: DesktopCompanyDiscoverySnapshot = snapshot(), requestId = randomUUID()): CompanyBriefSynthesizeInput {
    return { requestId, workspaceId: run.workspaceId, chatId: run.chatId, sourceRevision: companyBriefSourceRevision(run), model, snapshot: run }
}

const grounded = JSON.stringify({
    claims: [
        { section: 'Overview', text: 'Acme sells widgets.', sources: ['site'] },
        { section: 'Overview', text: 'Acme was founded in 1899.', sources: ['registry'] },
    ],
    unknowns: ['Pricing is not public.'],
})

let root: string, db: Client, calls: string[], service: CompanyBriefService, pages: Map<string, { hash: string; title: string; content: string }>, proposeCalls: number, brain: CompanyBriefBrain
const env = process.env.RERUN_DESKTOP_APP

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'company-brief-'))
    db = createClient({ url: `file:${join(root, 'brief.db')}` })
    calls = []
    pages = new Map()
    proposeCalls = 0
    brain = {
        async readPage(slug) { return pages.get(slug) ?? null },
        async openProposal() { return null },
        async propose(draft) {
            proposeCalls += 1
            return { status: 'proposed', id: `proposal-${proposeCalls}`, slug: draft.slug, fingerprint: `fp-${proposeCalls}` }
        },
    }
    service = createCompanyBriefService(async () => db, {
        model: { async confirm() { return true }, async complete({ prompt }) { calls.push(prompt); return grounded } },
        brain,
    })
    await service.initialize()
    process.env.RERUN_DESKTOP_APP = '1'
})
afterEach(async () => { db.close(); await rm(root, { recursive: true, force: true }); if (env === undefined) delete process.env.RERUN_DESKTOP_APP; else process.env.RERUN_DESKTOP_APP = env })

it('keeps snapshot-backed claims and turns unsupported sources into unknowns', async () => {
    const first = await service.synthesize(input(), new AbortController().signal)
    expect(first.modelCalled).toBe(true)
    expect(first.attempt.result?.claims.map(claim => claim.sources)).toEqual([['site']])
    expect(first.attempt.result?.brief).toContain('## Overview')
    expect(first.attempt.result?.brief).toContain('[site]')
    expect(first.attempt.result?.brief).toContain('## Open questions')
    expect(first.attempt.result?.brief).not.toContain('1899')
    expect(first.attempt.result?.unknowns).toContain('A claim cited a source the snapshot does not contain.')
    expect(first.attempt.result?.unknowns).toContain('Pricing is not public.')
    expect(first.attempt.result?.claims[0]?.links).toEqual([{ tag: 'site', url: 'https://acme.example' }])
    expect(first.attempt.result?.card.company.name).toBe('Acme')
    expect(first.attempt.result?.card.company.legalName).toBe('')
    const again = await service.synthesize(input(snapshot(), first.attempt.requestId), new AbortController().signal)
    expect(again.modelCalled).toBe(false)
    expect(again.attempt).toEqual(first.attempt)
    expect(calls).toHaveLength(1)
    expect(proposeCalls).toBe(0)
})

it('rejects a request id reused for another chat and does not read across chats', async () => {
    const made = await service.synthesize(input(), new AbortController().signal)
    const other = snapshot({ workspaceId, chatId: otherChat })
    await expect(service.synthesize(input(other, made.attempt.requestId), new AbortController().signal)).rejects.toMatchObject({ status: 409 })
    expect(await service.read(workspaceId, otherChat)).toBeNull()
    expect(calls).toHaveLength(1)
})

it('returns a stored result after a lost acknowledgement and does not synthesize on read', async () => {
    const made = await service.synthesize(input(), new AbortController().signal)
    expect(await service.read(workspaceId, chatId)).toEqual(made.attempt)
    expect(calls).toHaveLength(1)
    const recovered = await service.synthesize(input(snapshot(), made.attempt.requestId), new AbortController().signal)
    expect(recovered.modelCalled).toBe(false)
    expect(calls).toHaveLength(1)
})

it('drops a delayed model reply when the chat sources change', async () => {
    let release: (value: string) => void = () => {}
    let started: () => void = () => {}
    const gate = new Promise<void>(resolve => { started = resolve })
    const hanging = createCompanyBriefService(async () => db, {
        model: { async confirm() { return true }, async complete() { started(); return new Promise<string>(resolve => { release = resolve }) } },
        brain,
    })
    await hanging.initialize()
    const run = snapshot()
    const pending = hanging.synthesize(input(run), new AbortController().signal)
    await gate
    const changed = snapshot({ findings: [{ ...identity, name: 'Changed' }] })
    await hanging.observe({ workspaceId, chatId, sourceRevision: companyBriefSourceRevision(changed), active: true })
    release(grounded)
    const finished = await pending
    expect(finished.modelCalled).toBe(true)
    expect(finished.attempt.status).toBe('stale')
    expect(finished.attempt.result).toBeNull()
    expect(finished.attempt.result?.brief ?? '').not.toContain('Acme sells widgets')
})

it('stops a pending brief on restart and does not call the model again', async () => {
    let release: (value: string) => void = () => {}
    let started: () => void = () => {}
    const gate = new Promise<void>(resolve => { started = resolve })
    const live = createCompanyBriefService(async () => db, {
        model: { async confirm() { return true }, async complete() { started(); return new Promise<string>(resolve => { release = resolve }) } },
        brain,
    })
    await live.initialize()
    const body = input()
    const pending = live.synthesize(body, new AbortController().signal)
    await gate
    await live.initialize()
    expect((await live.read(workspaceId, chatId))?.status).toBe('stopped')
    release(grounded)
    expect((await pending).attempt.status).toBe('stopped')
    const recovered = await live.synthesize(body, new AbortController().signal)
    expect(recovered.modelCalled).toBe(false)
    expect(recovered.attempt.status).toBe('stopped')
})

it('cancels an in-flight brief and ignores the late reply', async () => {
    let release: (value: string) => void = () => {}
    let started: () => void = () => {}
    const gate = new Promise<void>(resolve => { started = resolve })
    const stopping = new AbortController()
    const live = createCompanyBriefService(async () => db, {
        model: { async confirm() { return true }, async complete() { started(); return new Promise<string>(resolve => { release = resolve }) } },
        brain,
    })
    await live.initialize()
    const pending = live.synthesize(input(), stopping.signal)
    await gate
    stopping.abort()
    release(grounded)
    const finished = await pending
    expect(finished.attempt.status).toBe('cancelled')
    expect(finished.attempt.result).toBeNull()
})

it('preserves edits on explicit same-source retry, while dismissal requires a fresh brief', async () => {
    const made = await service.synthesize(input(), new AbortController().signal)
    const edited = await service.edit({ requestId: made.attempt.requestId, workspaceId, chatId, expectedDraftRevision: 0, brief: 'Acme sells widgets, as corrected. [site]' })
    expect(edited.draft).toBe('Acme sells widgets, as corrected. [site]')
    expect(edited.result?.brief).toBe(made.attempt.result?.brief)
    await service.observe({ workspaceId, chatId, sourceRevision: 'a'.repeat(64), active: true })
    await expect(service.edit({ requestId: made.attempt.requestId, workspaceId, chatId, expectedDraftRevision: 1, brief: 'replaced' })).rejects.toMatchObject({ status: 409 })
    expect((await service.read(workspaceId, chatId))?.draft).toBe(edited.draft)
    await service.observe({ workspaceId, chatId, sourceRevision: made.attempt.sourceRevision, active: true })
    const retryCommand = { ...input(snapshot(), randomUUID()), previousRequestId: made.attempt.requestId }
    const retry = await service.retry(retryCommand, new AbortController().signal)
    expect(retry.attempt.draft).toBe(edited.draft)
    expect(retry.attempt.requestId).not.toBe(made.attempt.requestId)
    const dismissed = await service.dismiss(made.attempt.requestId, workspaceId, chatId)
    expect(dismissed.status).toBe('dismissed')
    const receipts = (await db.execute('SELECT * FROM desktop_company_brief_requests ORDER BY request_id')).rows
    expect(await service.retry(retryCommand, new AbortController().signal)).toEqual({ attempt: retry.attempt, modelCalled: false })
    expect((await db.execute('SELECT * FROM desktop_company_brief_requests ORDER BY request_id')).rows).toEqual(receipts)
    expect(calls).toHaveLength(2)
    await expect(service.retry({ ...input(snapshot(), randomUUID()), previousRequestId: made.attempt.requestId }, new AbortController().signal)).rejects.toMatchObject({ status: 409 })
    expect(proposeCalls).toBe(0)
})

it('refuses to carry an edited draft into a different discovery, run or canonical source revision', async () => {
    const made = await service.synthesize(input(), new AbortController().signal)
    await service.edit({ requestId: made.attempt.requestId, workspaceId, chatId, expectedDraftRevision: 0, brief: 'Old saved edit [site]' })
    const before = (await db.execute('SELECT * FROM desktop_company_brief_requests ORDER BY request_id')).rows
    for (const changed of [snapshot({ discoveryId: 'fmx_changed0001' }), snapshot({ runId: 'different-run' }), snapshot({ findings: [{ ...identity, name: 'Changed identity' }] })]) {
        await expect(service.retry({ ...input(changed), previousRequestId: made.attempt.requestId }, new AbortController().signal)).rejects.toMatchObject({ status: 409 })
    }
    expect((await db.execute('SELECT * FROM desktop_company_brief_requests ORDER BY request_id')).rows).toEqual(before)
    expect((await service.read(workspaceId, chatId))?.draft).toBe('Old saved edit [site]')
    expect(calls).toHaveLength(1)
    expect(proposeCalls).toBe(0)
})

it('proposes selected findings and will not overwrite a changed or deleted page', async () => {
    const made = await service.synthesize(input(), new AbortController().signal)
    const claimId = made.attempt.result!.claims[0]!.id
    pages.set('company', { hash: 'b'.repeat(32), title: 'Acme', content: 'Kept by the user.' })
    const wrong = await service.handoff({
        requestId: made.attempt.requestId, expectedDraftRevision: 0, handoffRequestId: randomUUID(), workspaceId, chatId,
        sourceRevision: made.attempt.sourceRevision, selectedClaimIds: [claimId], includeDraft: false,
        expectedPages: [{ slug: 'company', expectedPageHash: 'a'.repeat(32) }],
    })
    expect(wrong.status).toBe('rejected')
    expect(proposeCalls).toBe(0)
    expect(pages.get('company')?.content).toBe('Kept by the user.')
    const missing = await service.handoff({
        requestId: made.attempt.requestId, expectedDraftRevision: 0, handoffRequestId: randomUUID(), workspaceId, chatId,
        sourceRevision: made.attempt.sourceRevision, selectedClaimIds: [claimId], includeDraft: false,
        expectedPages: [{ slug: 'company', expectedPageHash: null }],
    })
    expect(missing.outcomes[0]?.code).toBe('page_changed')
    expect(proposeCalls).toBe(0)
    const recorded = await service.handoff({
        requestId: made.attempt.requestId, expectedDraftRevision: 0, handoffRequestId: randomUUID(), workspaceId, chatId,
        sourceRevision: made.attempt.sourceRevision, selectedClaimIds: [claimId], includeDraft: false,
        expectedPages: [{ slug: 'company', expectedPageHash: 'b'.repeat(32) }],
    })
    expect(recorded.status).toBe('recorded')
    expect(recorded.outcomes[0]?.status).toBe('proposed')
    expect(pages.get('company')?.content).toBe('Kept by the user.')
    expect(proposeCalls).toBe(1)
    const replay = await service.handoff({
        requestId: made.attempt.requestId, expectedDraftRevision: 0, handoffRequestId: recorded.handoffRequestId, workspaceId, chatId,
        sourceRevision: made.attempt.sourceRevision, selectedClaimIds: [claimId], includeDraft: false,
        expectedPages: [{ slug: 'company', expectedPageHash: 'b'.repeat(32) }],
    })
    expect(replay.recovered).toBe(true)
    expect(proposeCalls).toBe(1)
})

it('does not call a model when none is selected or the snapshot is still running', async () => {
    const quiet = createCompanyBriefService(async () => db, { model: { async confirm() { return false }, async complete() { calls.push('no'); return grounded } }, brain })
    await quiet.initialize()
    const refused = await quiet.synthesize(input(), new AbortController().signal)
    expect(refused.attempt.status).toBe('failed')
    expect(refused.attempt.error?.code).toBe('missing_model')
    await expect(service.synthesize(input(snapshot({ status: 'running' })), new AbortController().signal)).rejects.toMatchObject({ status: 409 })
    const empty = snapshot({ findings: [], unavailable: ['site', 'search'] })
    const skipped = await service.synthesize(input(empty), new AbortController().signal)
    expect(skipped.modelCalled).toBe(false)
    expect(skipped.attempt.status).toBe('skipped')
    expect(skipped.attempt.error?.message).toBe(COMPANY_BRIEF_NO_SOURCES)
    expect(calls).toHaveLength(0)
})

it('does not synthesize when the review route is only read', async () => {
    const made = await service.synthesize(input(), new AbortController().signal)
    const router = createDesktopCompanyBriefRouter(() => service)
    const response = await router.request(`/?workspaceId=${workspaceId}&chatId=${chatId}`)
    expect(response.status).toBe(200)
    expect((await response.json()).attempt.requestId).toBe(made.attempt.requestId)
    expect(calls).toHaveLength(1)
})


it('rejects request identity reuse with another saved model or canonical source revision', async () => {
    const request = input()
    await service.synthesize(request, new AbortController().signal)
    await expect(service.synthesize({ ...request, model: { ...model, model: 'changed' } }, new AbortController().signal)).rejects.toMatchObject({ status: 409 })
    const changed = snapshot({ url: 'https://other.example/' })
    await expect(service.synthesize({ ...request, snapshot: changed, sourceRevision: companyBriefSourceRevision(changed) }, new AbortController().signal)).rejects.toMatchObject({ status: 409 })
    expect(calls).toHaveLength(1)
})

it('does not call the model when cancellation happened during reservation', async () => {
    const stop = new AbortController(); let admitted = false
    const wrapper = new Proxy(db, { get(target, key) {
        if (key === 'execute') return async (stmt: Parameters<Client['execute']>[0]) => {
            const result = await db.execute(stmt)
            const sql = typeof stmt === 'string' ? stmt : stmt.sql
            if (/INSERT INTO desktop_company_briefs\(/.test(sql) && !admitted) { admitted = true; stop.abort() }
            return result
        }
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
    } })
    const guarded = createCompanyBriefService(async () => wrapper, { model: { confirm: async () => true, complete: async () => { calls.push('wrong'); return grounded } }, brain })
    await guarded.initialize()
    const result = await guarded.synthesize(input(), stop.signal)
    expect(result.attempt.status).toBe('cancelled')
    expect(result.modelCalled).toBe(false)
    expect(calls).toEqual([])
})


it('refuses a handoff ID reused with another brief or changed selected effect', async () => {
    const made = await service.synthesize(input(), new AbortController().signal)
    const command = { requestId: made.attempt.requestId, handoffRequestId: randomUUID(), workspaceId, chatId, sourceRevision: made.attempt.sourceRevision, expectedDraftRevision: 0, selectedClaimIds: [made.attempt.result!.claims[0]!.id], includeDraft: false, expectedPages: [{ slug: 'company', expectedPageHash: null }] }
    await service.handoff(command)
    await expect(service.handoff({ ...command, includeDraft: true })).rejects.toMatchObject({ status: 409 })
    const sibling = await service.synthesize(input(snapshot({ chatId: otherChat })), new AbortController().signal)
    await expect(service.handoff({ ...command, chatId: otherChat, requestId: sibling.attempt.requestId, sourceRevision: sibling.attempt.sourceRevision })).rejects.toMatchObject({ status: 409 })
    expect(proposeCalls).toBe(1)
})


it('drains the exact pending conversation when the global Foreman Stop cancels research', async () => {
    let started!: () => void
    const gate = new Promise<void>(resolve => { started = resolve })
    const live = createCompanyBriefService(async () => db, { model: { confirm: async () => true, complete: async ({ signal }) => {
        started()
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
        return grounded
    } }, brain })
    await live.initialize()
    const pending = live.synthesize(input(), new AbortController().signal)
    await gate
    await live.cancelChat(workspaceId, chatId)
    expect((await pending).attempt.status).toBe('cancelled')
    expect((await live.read(workspaceId, chatId))?.result).toBeNull()
})


it('recovers an exact committed handoff even after source context and Brain page hashes change', async () => {
    const made = await service.synthesize(input(), new AbortController().signal)
    const command = { requestId: made.attempt.requestId, handoffRequestId: randomUUID(), workspaceId, chatId, sourceRevision: made.attempt.sourceRevision, expectedDraftRevision: 0, selectedClaimIds: [made.attempt.result!.claims[0]!.id], includeDraft: false, expectedPages: [{ slug: 'company', expectedPageHash: null }] }
    const saved = await service.handoff(command)
    pages.set('company', { hash: 'c'.repeat(32), title: 'Changed', content: 'New page' })
    await service.observe({ workspaceId, chatId, sourceRevision: 'b'.repeat(64), active: false })
    const recovered = await service.handoff(command)
    expect(recovered).toEqual({ ...saved, recovered: true })
    expect(proposeCalls).toBe(1)
})

it('durably dismisses a handed brief after reopening without withdrawing or repeating its saved Brain proposal', async () => {
    const made = await service.synthesize(input(), new AbortController().signal)
    const edited = await service.edit({ requestId: made.attempt.requestId, workspaceId, chatId, expectedDraftRevision: 0, brief: 'Acme sells widgets, as corrected. [site]' })
    const command = { requestId: made.attempt.requestId, handoffRequestId: randomUUID(), workspaceId, chatId, sourceRevision: made.attempt.sourceRevision, expectedDraftRevision: edited.draftRevision, selectedClaimIds: [made.attempt.result!.claims[0]!.id], includeDraft: true, expectedPages: [{ slug: 'company', expectedPageHash: null }] }
    const receipt = await service.handoff(command)
    expect(receipt.status).toBe('recorded')
    const handoffRows = (await db.execute('SELECT * FROM desktop_company_brief_handoffs')).rows
    const identities = (await db.execute('SELECT * FROM desktop_company_brief_requests ORDER BY request_id')).rows
    const reopen = async () => {
        db.close()
        db = createClient({ url: `file:${join(root, 'brief.db')}` })
        service = createCompanyBriefService(async () => db, { model: {
            confirm: async () => { throw new Error('Reading or dismissing must not select a model.') },
            complete: async () => { throw new Error('Reading or dismissing must not call a provider.') },
        }, brain })
        await service.initialize()
    }
    await reopen()
    expect((await service.read(workspaceId, chatId))?.status).toBe('handed')
    await expect(service.dismiss(made.attempt.requestId, workspaceId, otherChat)).rejects.toMatchObject({ status: 409 })
    const dismissed = await service.dismiss(made.attempt.requestId, workspaceId, chatId)
    expect(dismissed).toMatchObject({ status: 'dismissed', draft: edited.draft, draftRevision: 1, result: made.attempt.result })
    expect(await service.dismiss(made.attempt.requestId, workspaceId, chatId)).toEqual(dismissed)
    await reopen()
    expect(await service.read(workspaceId, chatId)).toEqual(dismissed)
    expect(await service.readHandoff(command)).toEqual({ ...receipt, recovered: true })
    expect(await service.handoff(command)).toEqual({ ...receipt, recovered: true })
    await expect(service.handoff({ ...command, handoffRequestId: randomUUID() })).rejects.toMatchObject({ status: 409 })
    expect((await db.execute('SELECT * FROM desktop_company_brief_handoffs')).rows).toEqual(handoffRows)
    expect((await db.execute('SELECT * FROM desktop_company_brief_requests ORDER BY request_id')).rows).toEqual(identities)
    expect(calls).toHaveLength(1)
    expect(proposeCalls).toBe(1)
})
