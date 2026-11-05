// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { BrainProposal } from '@rerun/contracts'
import { DesktopBrainProposalsPanel } from './DesktopBrainProposalsPanel'
import type { DesktopBrainProposalView } from '@/lib/desktop/brain-proposals'
const mocks = vi.hoisted(() => {
    const state = new Map<string, unknown>()
    return { state, list: vi.fn(), decide: vi.fn(), toast: vi.fn(), persist: vi.fn(async (key: string, value: unknown) => { if (value === null) state.delete(key); else state.set(key, value) }) }
})
vi.mock('@/lib/desktop/brain-ui-state', () => ({ hydrateBrainUiState: async () => {}, readBrainUiState: (key: string) => mocks.state.get(key) ?? null, writeBrainUiState: mocks.persist }))
vi.mock('@/lib/desktop/brain-proposals', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/desktop/brain-proposals')>(), listDesktopBrainProposals: mocks.list, decideDesktopBrainProposal: mocks.decide }))
vi.mock('@/components/brain/BrainPageParts', () => ({ PageColumn: ({ children }: { children: ReactNode }) => <div>{children}</div> }))
vi.mock('@/components/brain/BrainTopBar', () => ({ BrainTopBar: () => null }))
vi.mock('@/components/brain/proposals/ProposalList', () => ({ ProposalList: ({ proposals, onAccept }: { proposals: BrainProposal[] | null; onAccept: (proposal: BrainProposal) => void }) => <div>{proposals?.map(proposal => <button key={proposal.id} onClick={() => onAccept(proposal)}>Accept {proposal.title}</button>)}</div> }))
vi.mock('@/lib/desktop/draft-writes', () => ({ holdDraftAdmission: () => () => {} }))
vi.mock('sonner', () => ({ toast: { success: mocks.toast, error: mocks.toast } }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const proposal: DesktopBrainProposalView = { id: 'one', agentId: 'alpha', agentName: 'Ada', sessionId: 'session', slug: 'pricing', mode: 'create', title: 'Pricing', headline: 'Public pricing', highlights: [], type: 'note', content: 'Public', reason: 'User said so', sources: [], baseHash: null, status: 'proposed', outdated: false, currentContent: null, createdAt: '2026-11-05', decidedAt: null, decidedBy: null, reviewedFingerprint: 'a'.repeat(64), expectedPageHash: null }
let root: Root | undefined
const mount = async (onDecided = vi.fn()) => {
    const element = document.createElement('div'); document.body.append(element); root = createRoot(element)
    await act(async () => { root!.render(<DesktopBrainProposalsPanel onOpenPage={vi.fn()} onDecided={onDecided} />) })
}
const click = async (name: string) => { await act(async () => { [...document.querySelectorAll('button')].find(button => button.textContent === name)!.click() }) }
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; mocks.state.clear(); document.body.innerHTML = ''; vi.clearAllMocks() })
it('retries the exact reviewed payload and request ID after remount, then signals the page refresh', async () => {
    mocks.list.mockResolvedValue([proposal])
    mocks.decide.mockRejectedValueOnce(new Error('Connection lost after commit'))
    await mount()
    await click('Accept Pricing')
    const first = mocks.decide.mock.calls[0]!
    expect(first.slice(0, 2)).toEqual(['one', 'accept'])
    expect(first[2]).toMatchObject({ reviewedFingerprint: proposal.reviewedFingerprint, expectedPageHash: null })
    expect(mocks.state.get('proposal-decision')).toMatchObject({ input: { requestId: first[2].requestId } })
    await act(async () => root!.unmount()); root = undefined
    mocks.list.mockResolvedValue([])
    mocks.decide.mockResolvedValueOnce({ proposal: { ...proposal, status: 'accepted' }, applied: true, slug: 'pricing', requestId: first[2].requestId })
    const refreshed = vi.fn()
    await mount(refreshed)
    await click('Retry decision')
    expect(mocks.decide.mock.calls[1]).toEqual(first)
    expect(refreshed).toHaveBeenCalledWith({ slug: 'pricing', requestId: first[2].requestId })
    expect(mocks.state.has('proposal-decision')).toBe(false)
})
