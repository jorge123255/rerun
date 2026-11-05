import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BRAIN_DB_MIGRATIONS } from '../db/brainDb.js'
import { createDesktopBrainPagesStore } from './brain-pages.js'
import { desktopBrainProposalFingerprint, type DesktopBrainProposalDraft, type DesktopBrainProposalView } from './brain-proposals.js'
import { createDesktopBrainProposalsRouter } from './brain-proposals-router.js'

let root: string, directory: string, db: Client, store: ReturnType<typeof createDesktopBrainPagesStore>
const env = process.env.RERUN_DESKTOP_APP
beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'desktop-brain-proposals-')))
    directory = join(root, 'brain'); await mkdir(directory)
    db = createClient({ url: `file:${join(root, 'brain.db')}` })
    for (const step of BRAIN_DB_MIGRATIONS) await step.up(db)
    store = createDesktopBrainPagesStore(directory, async () => db); await store.initialize()
    process.env.RERUN_DESKTOP_APP = '1'
})
afterEach(async () => { db.close(); await rm(root, { recursive: true, force: true }); if (env === undefined) delete process.env.RERUN_DESKTOP_APP; else process.env.RERUN_DESKTOP_APP = env; vi.restoreAllMocks() })
const draft = (patch: Partial<DesktopBrainProposalDraft> = {}): DesktopBrainProposalDraft => ({ agentId: 'alpha', agentName: 'Ada', sessionId: 'session-one', slug: 'pricing', title: 'Pricing', headline: 'Pricing is public', highlights: [{ label: 'Pricing', before: null, after: 'Public' }], type: 'note', content: 'The price is public.', reason: 'The user said so.', sources: ['told by the user'], baseHash: null, ...patch })
const decision = (proposal: DesktopBrainProposalView, requestId = randomUUID()) => ({ reviewedFingerprint: proposal.reviewedFingerprint, expectedPageHash: proposal.expectedPageHash, requestId })

it('atomically accepts reviewed bytes, revision attribution and receipt, then replays after reopen', async () => {
    const proposed = (await store.propose(draft())).proposal
    const input = decision(proposed)
    const accepted = await store.decideProposal(proposed.id, 'accept', input)
    expect(accepted).toMatchObject({ applied: true, slug: 'pricing', requestId: input.requestId, proposal: { status: 'accepted' } })
    const page = await store.readPage('pricing')
    expect(page.page.content).toBe(proposed.content)
    expect(page.revisions[0]?.proposalId).toBe(proposed.id)
    expect(await readFile(join(directory, 'pricing.md'), 'utf8')).toContain(proposed.content)
    store = createDesktopBrainPagesStore(directory, async () => db); await store.initialize()
    expect(await store.decideProposal(proposed.id, 'accept', input)).toEqual(accepted)
    expect((await store.readPage('pricing')).revisions).toHaveLength(1)
    await expect(store.decideProposal(proposed.id, 'dismiss', input)).rejects.toMatchObject({ status: 409 })
})
it('rejects a same-ID proposal replacement made after review, including title-only changes', async () => {
    const first = (await store.propose(draft())).proposal
    const newer = (await store.propose(draft({ title: 'Different title' }))).proposal
    expect(newer.id).toBe(first.id)
    expect(newer.reviewedFingerprint).not.toBe(first.reviewedFingerprint)
    await expect(store.decideProposal(first.id, 'accept', decision(first))).rejects.toMatchObject({ status: 409 })
    await expect(store.readPage('pricing')).rejects.toMatchObject({ status: 404 })
    expect(await store.countProposals()).toBe(1)
})
it('guards target existence and page hash under the same lock as proposal decisions', async () => {
    const proposal = (await store.propose(draft())).proposal
    await store.savePage('pricing', { title: 'Pricing', type: 'note', content: 'Written meanwhile', sources: [], baseHash: null }, randomUUID())
    await expect(store.decideProposal(proposal.id, 'accept', decision(proposal))).rejects.toMatchObject({ status: 409 })
    const refreshed = (await store.listProposals())[0]!
    expect(refreshed.outdated).toBe(true)
    await expect(store.decideProposal(proposal.id, 'accept', decision(refreshed))).rejects.toMatchObject({ status: 409 })
    expect((await store.readPage('pricing')).page.content).toBe('Written meanwhile')
})
it('keeps acceptance proposed and page absent when receipt insertion fails', async () => {
    const proposal = (await store.propose(draft())).proposal
    await db.executeMultiple("CREATE TRIGGER fail_receipt BEFORE INSERT ON desktop_brain_receipts BEGIN SELECT RAISE(ABORT, 'receipt failed'); END;")
    await expect(store.decideProposal(proposal.id, 'accept', decision(proposal))).rejects.toBeDefined()
    expect((await store.listProposals())[0]?.status).toBe('proposed')
    expect((await db.execute('SELECT * FROM brain_revisions')).rows).toEqual([])
    await expect(store.readPage('pricing')).rejects.toMatchObject({ status: 404 })
})
it('makes concurrent accept/dismiss one decision and binds optional reviewed edits', async () => {
    const proposal = (await store.propose(draft())).proposal
    const results = await Promise.allSettled([store.decideProposal(proposal.id, 'accept', { ...decision(proposal), edits: { content: 'A human edit' } }), store.decideProposal(proposal.id, 'dismiss', decision(proposal))])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(await store.countProposals()).toBe(0)
    const accepted = await store.listProposals('accepted')
    if (accepted.length) expect((await store.readPage('pricing')).page.content).toBe('A human edit')
    else await expect(store.readPage('pricing')).rejects.toMatchObject({ status: 404 })
})
it('rechecks tool permission at transaction commit and performs only local search', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network'))
    let checks = 0
    await expect(store.propose(draft(), { beforeCommit: () => { if (++checks === 2) throw new Error('Grant revoked') } })).rejects.toThrow('Grant revoked')
    expect(await store.countProposals()).toBe(0)
    const proposal = (await store.propose(draft())).proposal
    await store.decideProposal(proposal.id, 'accept', decision(proposal))
    expect((await store.search('public')).hits.map(hit => hit.slug)).toEqual(['pricing'])
    expect(network).not.toHaveBeenCalled()
})
it('fingerprints exact proposal facts, sources, identity and content', () => {
    const original = desktopBrainProposalFingerprint(draft())
    for (const patch of [{ content: 'THE PRICE IS PUBLIC.' }, { reason: 'Updated evidence' }, { sources: ['new source'] }, { headline: 'Review this' }, { sessionId: 'another-session' }]) expect(desktopBrainProposalFingerprint(draft(patch))).not.toBe(original)
})
it('rejects unreviewed and forged HTTP decisions and forwards strict reviewed identities', async () => {
    const proposal = (await store.propose(draft())).proposal
    const router = createDesktopBrainProposalsRouter(async () => store)
    const post = (body: unknown) => router.request(`/${proposal.id}/accept`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    expect((await post({})).status).toBe(400)
    expect((await post({ ...decision(proposal), decidedBy: 'forged' })).status).toBe(400)
    expect((await post(decision(proposal))).status).toBe(200)
    expect(await (await router.request('/count')).json()).toEqual({ count: 0 })
})
