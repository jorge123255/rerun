// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { EngineSkillProposal } from '@/lib/engine/types'
const state = vi.hoisted(() => ({ list: vi.fn(), decide: vi.fn(), quit: false, quitListeners: new Set<() => void>() }))
vi.mock('./coworker-skills', () => ({ listCoworkerSkillProposals: state.list, decideCoworkerSkillProposal: state.decide, DESKTOP_SKILL_PROPOSALS_CHANGED: 'desktop-skill-proposals-changed' }))
vi.mock('./draft-writes', () => ({ isDesktopQuitting: () => state.quit, subscribeDraftShutdown: (callback: () => void) => { state.quitListeners.add(callback); return () => state.quitListeners.delete(callback) } }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
import { useCoworkerSkillProposals } from './use-coworker-skill-proposals'
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const proposal = (status: EngineSkillProposal['status'] = 'proposed'): EngineSkillProposal => ({ id: 'proposal', sessionId: 'engine-session', toolCallId: 'engine-tool', mode: 'create', slug: null, title: 'Remember review steps', summary: 'Check the saved notes', instructions: ['Always check the saved notes first.'], status, appliedSlug: status === 'applied' ? 'review-steps' : null, error: null, createdAt: '2026-11-04T00:00:00Z' })
const snapshot = (row = proposal()) => ({ availability: 'complete' as const, proposals: [row] })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
let latest: ReturnType<typeof useCoworkerSkillProposals>, root: ReturnType<typeof createRoot>, container: HTMLDivElement
function Harness({ owner, session, active }: { owner: string; session: string; active: boolean }) { latest = useCoworkerSkillProposals(owner, { sessionId: session, active, mode: 'chat' }); return <div>{[...latest.proposals.values()].map(row => row.status).join(',')}:{latest.pendingId}</div> }
const render = (owner = 'alice', session = 'local-session', active = true) => act(async () => { root.render(<Harness owner={owner} session={session} active={active} />) })
beforeEach(() => {
    vi.useFakeTimers(); vi.clearAllMocks(); state.quit = false; state.quitListeners.clear()
    state.list.mockResolvedValue(snapshot()); state.decide.mockResolvedValue({ success: true, proposal: proposal('accepted') })
    container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers() })

test('an older same-owner read cannot replace an acknowledged decision; double clicks send one scoped request', async () => {
    await render()
    const oldRead = deferred<ReturnType<typeof snapshot>>(), decision = deferred<{ success: boolean; proposal: EngineSkillProposal }>()
    state.list.mockImplementationOnce(() => oldRead.promise)
    await act(async () => { void latest.refresh() })
    state.decide.mockImplementationOnce(() => decision.promise)
    const decide = latest.decide
    await act(async () => { void decide('proposal', 'accept'); void decide('proposal', 'dismiss') })
    expect(state.decide).toHaveBeenCalledExactlyOnceWith('alice', 'proposal', 'accept', 'local-session')
    state.list.mockResolvedValue(snapshot(proposal('accepted')))
    await act(async () => { decision.resolve({ success: true, proposal: proposal('accepted') }) })
    expect(latest.proposals.get('proposal')?.status).toBe('accepted')
    expect(latest.pinned).toEqual([])
    await act(async () => { oldRead.resolve(snapshot()) })
    expect(latest.proposals.get('proposal')?.status).toBe('accepted')
})

test('old callbacks cannot decide after tab switch, A–B–A owner changes, close/reopen or Quit', async () => {
    await render(); const first = latest.decide
    await render('alice', 'sibling-chat'); await render()
    await act(async () => { await first('proposal', 'accept') })
    expect(state.decide).not.toHaveBeenCalled()
    const second = latest.decide
    await render('bob'); await render()
    await act(async () => { await second('proposal', 'accept') })
    expect(state.decide).not.toHaveBeenCalled()
    const third = latest.decide
    await render('alice', 'local-session', false); await render()
    await act(async () => { await third('proposal', 'accept') })
    expect(state.decide).not.toHaveBeenCalled()
    await act(async () => { state.quit = true; for (const stop of state.quitListeners) stop(); await latest.decide('proposal', 'accept') })
    expect(state.decide).not.toHaveBeenCalled()
})

test('a late decision cannot clear another open cycle’s pending request or publish into its rows', async () => {
    await render()
    const old = deferred<{ success: boolean; proposal: EngineSkillProposal }>(), current = deferred<{ success: boolean; proposal: EngineSkillProposal }>()
    state.decide.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => current.promise)
    await act(async () => { void latest.decide('proposal', 'accept') })
    await render('alice', 'local-session', false); await render()
    await act(async () => { void latest.decide('proposal', 'dismiss') })
    await act(async () => { old.resolve({ success: true, proposal: proposal('applied') }) })
    expect(latest.pendingId).toBe('proposal')
    expect(latest.proposals.get('proposal')?.status).toBe('proposed')
    state.list.mockResolvedValue(snapshot(proposal('dismissed')))
    await act(async () => { current.resolve({ success: true, proposal: proposal('dismissed') }) })
    expect(latest.pendingId).toBeNull()
    expect(latest.proposals.get('proposal')?.status).toBe('dismissed')
})
