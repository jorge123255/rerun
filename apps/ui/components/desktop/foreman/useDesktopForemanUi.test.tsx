// @vitest-environment happy-dom
import { randomUUID } from 'node:crypto'
import { cancelDraftShutdown } from '@/lib/desktop/draft-writes'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DesktopForemanConversationView, DesktopForemanBuild } from '@rerun/contracts'
import { DEFAULT_DESKTOP_FOREMAN_PLACEMENT, fromContractBuild, type DesktopForemanActionPorts, type DesktopForemanChatRef, type DesktopForemanPersistedUi, type DesktopTrustedPlanSnapshot, type DesktopDiscoveryEvent } from '@/lib/desktop/foreman-client'
import { useDesktopForemanUi } from './useDesktopForemanUi'
import { DesktopForemanNextSteps } from './DesktopForemanNextSteps'

const chat = { workspaceId: 'workspace', chatId: 'fmc_abcdefgh' }
const other = { workspaceId: 'workspace', chatId: 'fmc_otherchat' }
const plan: DesktopTrustedPlanSnapshot = { ...chat, planId: 'fmp_abcdefgh', revisionId: 'fmr_abcdefgh', digest: 'a'.repeat(64), runId: 'finished-run', state: 'shown', streaming: false, plan: { title: 'Team', boxes: [], items: [] } }
const build: DesktopForemanBuild = { buildId: 'fmb_abcdefgh', decisionId: 'fmd_abcdefgh', revisionId: plan.revisionId, state: 'completed', boxes: [], items: [{ itemKey: 'lead', order: 0, kind: 'agent', title: 'Alex', boxKey: 'box', state: 'created', created: { agentIds: ['alex'], spaceId: 'space', sessionId: null }, failure: null, error: null, lead: true }], leadItemKey: 'lead', setup: { state: 'not_started', agentId: null, sessionId: null, error: null }, startedAt: 'now', updatedAt: 'now' }
function view(owner = chat): DesktopForemanConversationView { return { contractVersion: 1, chat: owner, phase: 'plan', live: null, revisions: [], currentRevisionId: plan.revisionId, decisions: [], build: null, discovery: null, blocked: null } }
function saved(owner = chat): DesktopForemanPersistedUi { return { ...owner, open: true, tab: 'assistant', draft: '', pendingPlanRevisionId: null, decision: { status: 'idle' }, build: null, discoveries: null, placement: DEFAULT_DESKTOP_FOREMAN_PLACEMENT } }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
let root: Root | undefined
let api: ReturnType<typeof useDesktopForemanUi>
let ports: DesktopForemanActionPorts
let persisted: Map<string, DesktopForemanPersistedUi>
function Probe({ owner = chat, live = null }: { owner?: DesktopForemanChatRef; live?: { runId: string } | null }) {
    api = useDesktopForemanUi({ chat: owner, ports, live, initialOpen: true })
    return <><button onClick={api.confirmPlan}>Confirm</button><DesktopForemanNextSteps steps={api.nextSteps} leadState={api.leadState} live={api.live} onStartLead={api.startLead} onOpenCreated={step => api.navigate({ kind: 'open_coworker', agentId: step.agentId, sessionId: step.sessionId })} /></>
}
const render = async (owner = chat, live: { runId: string } | null = null) => { if (!root) root = createRoot(document.body.appendChild(document.createElement('div'))); await act(async () => { root!.render(<Probe owner={owner} live={live} />) }) }
beforeEach(() => {
    cancelDraftShutdown()
    vi.stubGlobal('crypto', { randomUUID })
    persisted = new Map()
    ports = {
        persistence: { load: vi.fn(async owner => structuredClone(persisted.get(owner.chatId) ?? null)), save: vi.fn(async snapshot => { persisted.set(snapshot.chatId, structuredClone(snapshot)) }) },
        plans: { readShownPlan: vi.fn(async owner => ({ ...plan, ...owner })), readConversationView: vi.fn(async owner => view(owner)) },
        decisions: { submit: vi.fn(async request => ({ ok: true as const, requestId: request.requestId, revisionId: request.revisionId, decisionId: 'fmd_abcdefgh' })) },
        build: { readProgress: vi.fn(async () => null), act: vi.fn(async () => ({ error: 'not configured' })) },
        discovery: { capabilities: () => ({ available: true }), subscribe: vi.fn(() => () => undefined) },
        navigation: { dispatch: vi.fn() }, conversation: { sendMessage: vi.fn(async () => true), stop: vi.fn() },
        routines: { list: vi.fn(async () => ({ available: true, routines: [] })) },
    }
})
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ''; vi.unstubAllGlobals() })

it('retains historical discoveries and durably records one exact plan decision before dispatch after the proposing run ends', async () => {
    vi.mocked(ports.plans.readConversationView).mockResolvedValue({ ...view(), discovery: { discoveryId: 'fmx_abcdefgh', chat, runId: 'finished-run', url: 'https://example.com', status: 'done', pending: ['site'], unavailable: [], findings: [{ kind: 'audience', source: 'site', attribution: { url: 'https://example.com', fetchedAt: 'now' }, text: 'Saved audience' }] } })
    await render()
    expect(api.live).toBe(false); expect(api.discoveries.ended).toBe(true); expect(api.discoveries.loading).toBe(false)
    expect(api.discoveries.entries).toEqual([expect.objectContaining({ type: 'finding', finding: expect.objectContaining({ text: 'Saved audience' }) })])
    const save = deferred<void>()
    vi.mocked(ports.persistence.save).mockImplementationOnce(snapshot => { expect(snapshot.decision.status).toBe('pending'); return save.promise })
    await act(async () => { api.confirmPlan(); api.confirmPlan() })
    expect(ports.decisions.submit).not.toHaveBeenCalled()
    await act(async () => { save.resolve() })
    expect(ports.decisions.submit).toHaveBeenCalledTimes(1)
    expect(vi.mocked(ports.decisions.submit).mock.calls[0]?.[0]).toMatchObject({ chat, revisionId: plan.revisionId, digest: plan.digest })
    expect(api.ui.decision.status).toBe('acknowledged')
})

it('serializes draft saves and waits for them before reading a remounted chat', async () => {
    await render()
    const first = deferred<void>()
    vi.mocked(ports.persistence.save).mockImplementationOnce(async snapshot => { await first.promise; persisted.set(snapshot.chatId, structuredClone(snapshot)) })
    await act(async () => { api.setDraft('first'); api.setDraft('newest') })
    expect(vi.mocked(ports.persistence.save).mock.calls.at(-1)?.[0].draft).toBe('first')
    await act(async () => root!.unmount()); root = undefined
    const loads = vi.mocked(ports.persistence.load).mock.calls.length
    await render()
    expect(api.restored).toBe(false); expect(ports.persistence.load).toHaveBeenCalledTimes(loads)
    await act(async () => { first.resolve() })
    expect(api.ui.draft).toBe('newest'); expect(persisted.get(chat.chatId)?.draft).toBe('newest')
})

it('cancels old chat reads and ignores old decision acknowledgements after switching identity', async () => {
    await render()
    const response = deferred<Awaited<ReturnType<typeof ports.decisions.submit>>>()
    vi.mocked(ports.decisions.submit).mockReturnValue(response.promise)
    await act(async () => { api.confirmPlan() })
    const request = vi.mocked(ports.decisions.submit).mock.calls[0]![0]
    const signal = vi.mocked(ports.decisions.submit).mock.calls[0]![1]!
    await render(other)
    expect(signal.aborted).toBe(true)
    await act(async () => { api.setDraft('other draft'); response.resolve({ ok: true as const, requestId: request.requestId, revisionId: request.revisionId, decisionId: 'fmd_abcdefgh' }) })
    expect(api.ui.chatId).toBe(other.chatId); expect(api.ui.draft).toBe('other draft'); expect(api.ui.decision.status).toBe('idle')
    expect(persisted.get(chat.chatId)?.decision.status).toBe('pending')
    expect(persisted.get(other.chatId)?.decision.status).toBe('idle')
})

it('restores pending decisions as explicit same-request recovery, never automatically dispatches', async () => {
    const request = { decision: 'confirm' as const, requestId: randomUUID(), chat, planId: plan.planId, revisionId: plan.revisionId, digest: plan.digest }
    persisted.set(chat.chatId, { ...saved(), decision: { status: 'pending', request, startedAt: 1 } })
    vi.mocked(ports.plans.readConversationView).mockResolvedValue({ ...view(), blocked: 'decision_uncertain' })
    await render()
    expect(api.ui.decision.status).toBe('uncertain'); expect(ports.decisions.submit).not.toHaveBeenCalled()
    await act(async () => { api.retryDecision() })
    expect(vi.mocked(ports.decisions.submit).mock.calls[0]?.[0]).toEqual(request)
})

it('does not clear later text or another chat when a send acknowledgement arrives', async () => {
    await render()
    const accepted = deferred<boolean>()
    vi.mocked(ports.conversation.sendMessage).mockReturnValue(accepted.promise)
    await act(async () => { api.setDraft('sent'); void api.sendMessage('sent'); api.setDraft('new draft') })
    await act(async () => { accepted.resolve(true) })
    expect(api.ui.draft).toBe('new draft')
    const second = deferred<boolean>()
    vi.mocked(ports.conversation.sendMessage).mockReturnValue(second.promise)
    await act(async () => { void api.sendMessage('new draft') })
    await render(other)
    await act(async () => { api.setDraft('other draft'); second.resolve(true) })
    expect(api.ui.draft).toBe('other draft')
})

it('unsubscribes discovery and rejects retained callbacks from a replaced live run', async () => {
    let callback!: (event: DesktopDiscoveryEvent) => void
    const unsubscribed = vi.fn()
    vi.mocked(ports.discovery.subscribe).mockImplementation((_owner, onEvent) => { callback = onEvent; return unsubscribed })
    await render(chat, { runId: 'run-one' })
    const stale = callback
    await render(chat, { runId: 'run-two' })
    await act(async () => { stale({ type: 'pending', source: 'site' }) })
    expect(unsubscribed).toHaveBeenCalled(); expect(api.discoveries.loading).toBe(false)
    await act(async () => { callback({ type: 'pending', source: 'search' }) })
    expect(api.discoveries.entries).toEqual([expect.objectContaining({ source: 'search' })])
})

it('allows an explicit lead action on a saved build and never navigates after its chat is replaced', async () => {
    vi.mocked(ports.plans.readConversationView).mockImplementation(async owner => ({ ...view(owner), build }))
    const result = deferred<Awaited<ReturnType<typeof ports.build.act>>>()
    vi.mocked(ports.build.act).mockReturnValue(result.promise)
    await render()
    const button = Array.from(document.querySelectorAll('button')).find(button => button.textContent?.includes('Start installing'))!
    expect(button).toBeTruthy()
    await act(async () => button.click())
    expect(ports.build.act).toHaveBeenCalledTimes(1)
    const signal = vi.mocked(ports.build.act).mock.calls[0]![1]!
    await render(other)
    await act(async () => { result.resolve(fromContractBuild({ ...build, setup: { state: 'started', agentId: 'alex', sessionId: 'setup', error: null } }, chat)) })
    expect(signal.aborted).toBe(true); expect(ports.navigation.dispatch).not.toHaveBeenCalled()
    expect(api.leadState.status).toBe('idle')
})

it('fails closed when secure request identifiers are unavailable', async () => {
    await render()
    vi.stubGlobal('crypto', {})
    await act(async () => { api.confirmPlan() })
    expect(api.error).toContain('Secure request identifiers'); expect(ports.decisions.submit).not.toHaveBeenCalled()
})

it('does not execute a decision when its recovery identity could not be saved', async () => {
    await render()
    vi.mocked(ports.persistence.save).mockRejectedValueOnce(new Error('disk full'))
    await act(async () => { api.confirmPlan() })
    expect(api.ui.decision.status).toBe('failed'); expect(ports.decisions.submit).not.toHaveBeenCalled()
})

it('Escape inside a dialog leaves Foreman open; Escape from the board closes it', async () => {
    await render()
    const dialog = document.body.appendChild(document.createElement('div'))
    dialog.setAttribute('role', 'dialog')
    const input = dialog.appendChild(document.createElement('input'))
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(api.ui.open).toBe(true)
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(api.ui.open).toBe(false)
})
