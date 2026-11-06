import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { COMPANY_BRIEF_NO_SOURCES, type CompanyBriefModelRef, type CompanyBriefSynthesizeInput, type DesktopForemanDiscoveryRun } from '@rerun/contracts'
import type { CompanyBriefBrain } from './brain.js'
import { createDesktopCompanyBriefRouter } from './router.js'
import { companyBriefSourceRevision } from './revision.js'
import { createCompanyBriefService, type CompanyBriefService } from './service.js'

const model: CompanyBriefModelRef = { connectionId: 'conn-1', provider: 'openai', model: 'gpt-test', source: 'workspace', agentId: null }
const workspaceId = 'workspace-1'
const chatId = 'fmc_chat0001'
const otherChat = 'fmc_chat0002'

const identity: DesktopForemanDiscoveryRun['findings'][number] = {
    kind: 'identity', source: 'site', attribution: { url: 'https://acme.example', fetchedAt: '2026-01-01T00:00:00.000Z' },
    name: 'Acme', oneLiner: 'Acme sells widgets.', logoUrl: null, domain: 'acme.example',
}

function snapshot(patch: Partial<DesktopForemanDiscoveryRun> = {}): DesktopForemanDiscoveryRun {
    return {
        discoveryId: 'fmx_disc0001', chat: { workspaceId, chatId }, runId: 'run-1', url: 'https://acme.example',
        status: 'done', pending: [], unavailable: ['search', 'registry', 'linkedinCompany'], findings: [identity], ...patch,
    }
}

function input(run: DesktopForemanDiscoveryRun = snapshot(), requestId = randomUUID()): CompanyBriefSynthesizeInput {
    return { requestId, workspaceId: run.chat.workspaceId, chatId: run.chat.chatId, sourceRevision: companyBriefSourceRevision(run), model, snapshot: run }
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
    const other = snapshot({ chat: { workspaceId, chatId: otherChat } })
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

it('edits, dismisses and retries without clearing the draft or proposing', async () => {
    const made = await service.synthesize(input(), new AbortController().signal)
    const edited = await service.edit({ requestId: made.attempt.requestId, workspaceId, chatId, expectedDraftRevision: 0, brief: 'Acme sells widgets, as corrected. [site]' })
    expect(edited.draft).toBe('Acme sells widgets, as corrected. [site]')
    expect(edited.result?.brief).toBe(made.attempt.result?.brief)
    await service.observe({ workspaceId, chatId, sourceRevision: 'a'.repeat(64), active: true })
    await expect(service.edit({ requestId: made.attempt.requestId, workspaceId, chatId, expectedDraftRevision: 1, brief: 'replaced' })).rejects.toMatchObject({ status: 409 })
    expect((await service.read(workspaceId, chatId))?.draft).toBe(edited.draft)
    await service.observe({ workspaceId, chatId, sourceRevision: made.attempt.sourceRevision, active: true })
    const dismissed = await service.dismiss(made.attempt.requestId, workspaceId, chatId)
    expect(dismissed.status).toBe('dismissed')
    expect(proposeCalls).toBe(0)
    const retry = await service.retry({ ...input(snapshot(), randomUUID()), previousRequestId: made.attempt.requestId }, new AbortController().signal)
    expect(retry.attempt.draft).toBe(edited.draft)
    expect(retry.attempt.requestId).not.toBe(made.attempt.requestId)
    expect(proposeCalls).toBe(0)
})

it('proposes selected findings and will not overwrite a changed or deleted page', async () => {
    const made = await service.synthesize(input(), new AbortController().signal)
    const claimId = made.attempt.result!.claims[0]!.id
    pages.set('company', { hash: 'b'.repeat(32), title: 'Acme', content: 'Kept by the user.' })
    const wrong = await service.handoff({
        requestId: made.attempt.requestId, handoffRequestId: randomUUID(), workspaceId, chatId,
        sourceRevision: made.attempt.sourceRevision, selectedClaimIds: [claimId], includeDraft: false,
        expectedPages: [{ slug: 'company', expectedPageHash: 'a'.repeat(32) }],
    })
    expect(wrong.status).toBe('rejected')
    expect(proposeCalls).toBe(0)
    expect(pages.get('company')?.content).toBe('Kept by the user.')
    const missing = await service.handoff({
        requestId: made.attempt.requestId, handoffRequestId: randomUUID(), workspaceId, chatId,
        sourceRevision: made.attempt.sourceRevision, selectedClaimIds: [claimId], includeDraft: false,
        expectedPages: [{ slug: 'company', expectedPageHash: null }],
    })
    expect(missing.outcomes[0]?.code).toBe('page_changed')
    expect(proposeCalls).toBe(0)
    const recorded = await service.handoff({
        requestId: made.attempt.requestId, handoffRequestId: randomUUID(), workspaceId, chatId,
        sourceRevision: made.attempt.sourceRevision, selectedClaimIds: [claimId], includeDraft: false,
        expectedPages: [{ slug: 'company', expectedPageHash: 'b'.repeat(32) }],
    })
    expect(recorded.status).toBe('recorded')
    expect(recorded.outcomes[0]?.status).toBe('proposed')
    expect(pages.get('company')?.content).toBe('Kept by the user.')
    expect(proposeCalls).toBe(1)
    const replay = await service.handoff({
        requestId: made.attempt.requestId, handoffRequestId: recorded.handoffRequestId, workspaceId, chatId,
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
