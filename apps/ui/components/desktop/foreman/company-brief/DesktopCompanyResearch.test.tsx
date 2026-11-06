// @vitest-environment happy-dom
import { randomUUID } from 'node:crypto'
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { emptyCompanyDiscoverySnapshot, type CompanyBriefAttempt } from '@rerun/contracts'
import { cancelDraftShutdown } from '@/lib/desktop/draft-writes'
type BriefReviewProps = ComponentProps<typeof import('./DesktopCompanyBriefReview').DesktopCompanyBriefReview>
vi.mock('@/components/builder/discoveries/DiscoveryCard', () => ({ DiscoveryCard: () => <span>Finding</span> }))
vi.mock('./DesktopCompanyBriefReview', () => ({ DesktopCompanyBriefReview: (props: BriefReviewProps) => props.attempt ? <aside aria-label="Company brief"><button onClick={() => props.onDraft('Unsaved correction [site]')}>Change draft</button><button onClick={() => props.onToggleClaim('claim-1')}>Select claim</button><button onClick={props.onHandoff}>Propose</button></aside> : null }))
import { DesktopCompanyResearch } from './DesktopCompanyResearch'
const chat = { workspaceId: '1', chatId: 'fmc_research0001' }
const snapshot = { ...emptyCompanyDiscoverySnapshot({ ...chat, discoveryId: 'fmx_research001', runId: 'run-1', url: 'https://acme.example/', domain: 'acme.example', startedAt: '2026-11-06T00:00:00.000Z' }), status: 'done' as const }
const attempt: CompanyBriefAttempt = { requestId: '11111111-1111-4111-8111-111111111111', ...chat, discoveryId: snapshot.discoveryId, runId: snapshot.runId, sourceRevision: 'a'.repeat(64), model: { connectionId: 'codex', provider: 'codex', model: 'terra', source: 'workspace', agentId: null }, status: 'accepted', result: null, draft: 'Saved [site]', draftRevision: 0, error: null }
let root: Root | undefined, posts: Record<string, unknown>[], reads: number
const state = () => ({ snapshot, sourceRevision: attempt.sourceRevision, attempt, expectedPages: [{ slug: 'company', expectedPageHash: (reads > 1 ? 'c' : 'b').repeat(32) }] })
async function render() { root ??= createRoot(document.body.appendChild(document.createElement('div'))); await act(async () => root!.render(<DesktopCompanyResearch chat={chat} active />)) }
async function click(label: string) { await act(async () => { [...document.querySelectorAll('button')].find(button => button.textContent === label)!.click() }) }
beforeEach(() => { cancelDraftShutdown(); posts = []; reads = 0; vi.stubGlobal('crypto', { randomUUID }); vi.stubGlobal('fetch', vi.fn(async (_url, init?: RequestInit) => {
    if (!init?.body) { reads++; return Response.json(state()) }
    const input = JSON.parse(String(init.body)); posts.push(input)
    if (posts.length === 1) throw new Error('Lost acknowledgement')
    return Response.json({ handoffRequestId: input.handoffRequestId, requestId: input.requestId, status: 'rejected', outcomes: [], recovered: true })
})) })
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ''; vi.unstubAllGlobals(); cancelDraftShutdown() })
it('mounts a single review surface and refuses to propose an unsaved visible draft', async () => {
    await render()
    expect(posts).toEqual([])
    expect(document.querySelectorAll('[aria-label="Company brief"]')).toHaveLength(1)
    expect(document.querySelector('[aria-label="Company research"]')).toBeNull()
    await click('Change draft'); await click('Select claim'); await click('Propose')
    expect(posts).toEqual([])
    expect(document.body.textContent).toContain('Save your edits before proposing')
})
it('retries the original immutable effect after a lost acknowledgement and a later read changes page hashes', async () => {
    await render(); await click('Select claim'); await click('Propose')
    expect(posts).toHaveLength(1)
    expect(posts[0].expectedPages).toEqual([{ slug: 'company', expectedPageHash: 'b'.repeat(32) }])
    await click('Retry previous action')
    expect(posts).toHaveLength(2)
    expect(posts[1]).toEqual(posts[0])
    expect(document.body.textContent).toContain('proposal was not added')
    expect(document.body.textContent).not.toContain('were sent to Company Brain')
})
