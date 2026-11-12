// @vitest-environment happy-dom
import { act, useState, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cancelDraftShutdown } from '@/lib/desktop/draft-writes'
import { DEFAULT_DESKTOP_FOREMAN_PLACEMENT, type DesktopForemanActionPorts } from '@/lib/desktop/foreman-client'
type DockBindingInput = Parameters<typeof import('./dock').useDesktopForemanDockBinding>[0]
type DockLayoutProps = ComponentProps<typeof import('./dock').DesktopForemanDockLayout>
type ParkedForemanProps = ComponentProps<typeof import('./dock').DesktopParkedForeman>
type HeaderProps = ComponentProps<typeof import('./DesktopForemanHeader').DesktopForemanHeader>
type ComposerProps = ComponentProps<typeof import('./DesktopForemanComposer').DesktopForemanComposer>
const history = vi.hoisted(() => ({ changes: [] as boolean[] }))
vi.mock('./dock', () => ({
    useDesktopForemanDockBinding: (props: DockBindingInput) => ({ scope: '1:chat', placement: props.placement, dock: props.dock, onPlacement: props.setPlacement, onDock: props.setDock }),
    DesktopForemanDockLayout: (props: DockLayoutProps) => <div data-open={String(props.open)}><button onClick={props.onClose}>Close frame</button>{props.children({ onPointerDown() {} })}</div>,
    DesktopParkedForeman: (props: ParkedForemanProps) => <div><button onClick={props.onOpen}>Open parked</button>{props.voiceSlot}</div>,
}))
vi.mock('@rerun/ui/primitives/use-is-mobile', () => ({ useIsMobile: () => false }))
vi.mock('./DesktopForemanHeader', () => ({ DesktopForemanHeader: (props: HeaderProps) => <button onClick={() => props.onTabChange('routines')}>Routines tab</button> }))
vi.mock('./DesktopForemanComposer', () => ({ DesktopForemanComposer: (props: ComposerProps) => <div><textarea data-desktop-foreman-composer aria-label="Message the Foreman" value={props.draft} onChange={event => props.onDraftChange(event.target.value)} disabled={props.disabled} />{props.trailing}{props.controls}<button disabled={props.sendDisabled} onClick={() => props.onSend(props.draft)}>Send draft</button></div> }))
vi.mock('./DesktopForemanChatLayer', () => ({ DesktopForemanChatLayer: ({ children, renderChildWork, question, error }: ComponentProps<typeof import('./DesktopForemanChatLayer').DesktopForemanChatLayer>) =>
    <div>Chat{renderChildWork?.(new Map())}{question}{children}{error && <p role="alert">{error}</p>}</div> }))
vi.mock('./routines/DesktopWorkspaceRoutines', () => ({ DesktopWorkspaceRoutines: () => <div>Routines content</div> }))
vi.mock('./plan/DesktopPlanBoardPreview', () => ({ DesktopPlanBoardPreview: () => null }))
import { DesktopForemanColumn } from './DesktopForemanColumn'
const chat = { workspaceId: '1', chatId: 'fmc_mounted0001' }
let root: Root | undefined
let ports: DesktopForemanActionPorts
function Host() {
    const [open, setOpen] = useState(true)
    return <DesktopForemanColumn chat={chat} ports={ports} live={null} messages={[]} agentNameOf={id => id} controlledOpen={open} onClose={() => setOpen(false)} onOpenChange={value => { history.changes.push(value); setOpen(value) }} focusRequest="command-once" composerTrailing={<span data-model-view>Current model</span>} voiceSlot={<span data-voice-view>Voice controls</span>} />
}
async function click(label: string) { await act(async () => { [...document.querySelectorAll('button')].find(button => button.textContent === label)!.click() }) }
beforeEach(() => {
    cancelDraftShutdown(); history.changes = []
    ports = {
        persistence: { load: vi.fn(async () => ({ ...chat, open: false, tab: 'assistant', draft: '', pendingPlanRevisionId: null, decision: { status: 'idle' }, build: null, discoveries: null, placement: DEFAULT_DESKTOP_FOREMAN_PLACEMENT })), save: vi.fn(async () => {}) },
        plans: { readShownPlan: vi.fn(async () => null), readConversationView: vi.fn(async () => ({ contractVersion: 1, chat, phase: 'plan', live: null, revisions: [], currentRevisionId: null, decisions: [], build: null, discovery: null, blocked: null })) },
        build: { readProgress: vi.fn(async () => null) }, decisions: { submit: vi.fn() }, discovery: { capabilities: () => ({ available: false }), subscribe: vi.fn() }, navigation: { dispatch: vi.fn() }, conversation: { sendMessage: vi.fn(), stop: vi.fn() }, routines: { list: vi.fn() },
    } as unknown as DesktopForemanActionPorts
})
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ''; cancelDraftShutdown(); vi.unstubAllGlobals() })
it('restores a closed saved view under controlled open without echoing the old value back to its owner', async () => {
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<Host />))
    expect(document.querySelector('[data-open]')?.getAttribute('data-open')).toBe('true')
    expect(history.changes).not.toContain(false)
    expect(document.activeElement).toBe(document.querySelector('[data-desktop-foreman-composer]'))
    expect(vi.mocked(ports.persistence.save).mock.calls.length).toBeLessThan(10)
    expect(document.querySelectorAll('[data-voice-view]')).toHaveLength(1)
    expect(document.querySelectorAll('[data-model-view]')).toHaveLength(1)
})
it('consumes command focus once so closing or choosing Routines does not reopen an old command', async () => {
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<Host />))
    await click('Close frame')
    expect(document.querySelector('[data-open]')?.getAttribute('data-open')).toBe('false')
    await act(async () => root!.render(<Host />))
    expect(document.querySelector('[data-open]')?.getAttribute('data-open')).toBe('false')
    await click('Open parked'); await click('Routines tab')
    expect(document.body.textContent).toContain('Routines content')
    expect(document.querySelectorAll('[data-voice-view]')).toHaveLength(1)
})

it('shows current and saved Chief of Staff tasks and stops only the selected task in the active turn', async () => {
    const revision = crypto.randomUUID()
    const tasks = ['Review launch notes', 'Summarize feedback'].map(title => ({
        taskId: crypto.randomUUID(), title, status: 'running', steps: 1, toolCalls: 0, failures: 0, preview: '', calls: [],
        cleanup: 'pending', stopRevision: crypto.randomUUID(),
    }))
    const live = { runId: 'active-run' }
    const active = { delegationId: crypto.randomUUID(), revision, parentAgentId: 'foreman',
        parentSessionId: chat.chatId, parentRunId: live.runId, toolCallId: 'repeated-tool-id', tasks }
    const saved = { ...active, delegationId: crypto.randomUUID(), parentRunId: 'older-run',
        tasks: [{ ...tasks[0], taskId: crypto.randomUUID(), title: 'Archived task', status: 'done', cleanup: 'complete' }] }
    const stopBody = vi.fn()
    const fetchDelegations = vi.fn(async (url: string, init?: RequestInit) => {
        if (url === `/api/desktop/foreman/${chat.chatId}/coworker-calls`) return Response.json({ calls: [] })
        expect(url).toBe(`/api/desktop/foreman/${chat.chatId}/delegation`)
        if (init?.method === 'POST') {
            stopBody(JSON.parse(String(init.body)))
            active.tasks = [{ ...tasks[0]!, status: 'stopped', cleanup: 'complete' }, tasks[1]!]
            return Response.json({ delegation: active })
        }
        return Response.json({ delegations: [saved, active] })
    })
    vi.stubGlobal('fetch', fetchDelegations)
    root = createRoot(document.body.appendChild(document.createElement('div')))
    const column = (turn: typeof live | null) => <DesktopForemanColumn chat={chat} ports={ports} live={turn} messages={[]}
        sessionId="engine-session" agentNameOf={id => id} controlledOpen />
    await act(async () => root!.render(column(live)))
    const stops = () => [...document.querySelectorAll<HTMLButtonElement>('button[aria-label="Stop this task"]')]
    expect(document.body.textContent).toContain('Review launch notes')
    expect(document.body.textContent).toContain('Summarize feedback')
    expect(stops()).toHaveLength(2)
    await act(async () => stops()[0]!.click())
    expect(stopBody).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ delegationId: active.delegationId,
        taskId: tasks[0]!.taskId, expectedRevision: tasks[0]!.stopRevision }))
    expect(stops()).toHaveLength(1)
    expect(ports.conversation.stop).not.toHaveBeenCalled()
    await act(async () => root!.render(column(null)))
    expect(stops()).toHaveLength(0)
    const archived = document.querySelector<HTMLButtonElement>(`[data-delegation-id="${saved.delegationId}"] button[aria-expanded]`)!
    await act(async () => archived.click())
    expect(document.body.textContent).toContain('Archived task')
})

it('reads a call that settles between polls, stops detached work, and opens its exact saved chat', async () => {
    const date = '2026-11-11T20:00:00.000Z'
    const dispatched = { callId: crypto.randomUUID(), revision: '4', parentAgentId: 'foreman', parentSessionId: chat.chatId,
        parentRunId: 'public-call-run', toolCallId: 'call-tool', targetAgentId: 'coworker-42', targetSessionId: 'target-chat-42',
        targetName: 'Ada', wait: false, status: 'dispatched', createdAt: date, updatedAt: date,
        progress: { steps: 0, toolCalls: 0, failures: 0, preview: '', calls: [] } }
    let saved: typeof dispatched | null = null
    const open = vi.fn(async () => {})
    const stop = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        if (url === `/api/desktop/foreman/${chat.chatId}/delegation`) return Response.json({ delegations: [] })
        expect(url).toBe(`/api/desktop/foreman/${chat.chatId}/coworker-calls`)
        if (init?.method === 'POST') {
            stop(JSON.parse(String(init.body)))
            saved = { ...dispatched, status: 'cancelled', revision: '5' }
            return Response.json({ call: saved })
        }
        return Response.json({ calls: saved ? [saved] : [] })
    }))
    root = createRoot(document.body.appendChild(document.createElement('div')))
    const render = (live: { runId: string } | null) => act(async () => root!.render(
        <DesktopForemanColumn chat={chat} ports={ports} live={live} messages={[]} sessionId="engine-session"
            agentNameOf={id => id} controlledOpen onOpenCalledChat={open} />))
    await render({ runId: 'caller-turn-request' })
    expect(document.querySelector('[aria-label="Coworker calls"]')).toBeNull()
    saved = dispatched
    await render(null)
    expect(document.querySelector('[aria-label="Coworker calls"]')?.textContent).toContain('Ada')
    await click('Stop call')
    expect(stop).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ callId: dispatched.callId, expectedRevision: '4' }))
    expect(document.body.textContent).toContain('Ada stopped')
    expect(ports.conversation.stop).not.toHaveBeenCalled()
    await click('Open chat')
    expect(open).toHaveBeenCalledExactlyOnceWith({ agentId: dispatched.targetAgentId, sessionId: dispatched.targetSessionId })
})

it('renders the saved action card and sends only the decision for its exact request', async () => {
    root = createRoot(document.body.appendChild(document.createElement('div')))
    const approval = { id: 'a'.repeat(64), messageId: 'saved-approval', toolCallId: 'review-call',
        approvals: [{ action: 'Open the synthetic report' }] }
    const decide = vi.fn(async () => {})
    await act(async () => root!.render(<DesktopForemanColumn chat={chat} ports={ports} live={null} messages={[]} agentNameOf={id => id}
        controlledOpen onClose={() => {}} approval={approval} onDecideApproval={decide} />))
    expect(document.body.textContent).toContain('Open the synthetic report')
    expect(document.querySelector<HTMLTextAreaElement>('[data-desktop-foreman-composer]')?.disabled).toBe(true)
    await click('Approve')
    expect(decide).toHaveBeenCalledExactlyOnceWith({ approvalId: approval.id, requestId: expect.any(String), decisions: [{ decision: 'approved' }] })
    expect(ports.conversation.sendMessage).not.toHaveBeenCalled()
})

it('retries an unconfirmed send by its saved request ID, clears the old error, and keeps a different draft', async () => {
    const stored = (await ports.persistence.load(chat))!
    const pendingSend = { requestId: crypto.randomUUID(), text: 'Original message', modelChoice: null }
    vi.mocked(ports.persistence.load).mockResolvedValue({ ...stored, draft: pendingSend.text })
    vi.mocked(ports.conversation.sendMessage).mockRejectedValueOnce(new Error('Lost first acknowledgement'))
    const retry = vi.fn(async () => true)
    root = createRoot(document.body.appendChild(document.createElement('div')))
    const render = (pending?: typeof pendingSend) => act(async () => root!.render(
        <DesktopForemanColumn chat={chat} ports={ports} live={null} messages={[]} agentNameOf={id => id}
            controlledOpen pendingSend={pending} onRetryPendingSend={retry} />))
    await render()
    await click('Send draft')
    expect(document.body.textContent).toContain('Lost first acknowledgement')
    const composer = document.querySelector<HTMLTextAreaElement>('[data-desktop-foreman-composer]')!
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(composer, 'The next draft')
        composer.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await render(pendingSend)
    expect(document.body.textContent).toContain('The previous message is unconfirmed.')
    expect([...document.querySelectorAll('button')].find(button => button.textContent === 'Send draft')?.disabled).toBe(true)
    await click('Retry previous message')
    expect(retry).toHaveBeenCalledExactlyOnceWith(pendingSend.requestId)
    expect(ports.conversation.sendMessage).toHaveBeenCalledExactlyOnceWith(pendingSend.text)
    expect(document.body.textContent).not.toContain('Lost first acknowledgement')
    await render()
    expect(document.querySelector<HTMLTextAreaElement>('[data-desktop-foreman-composer]')?.value).toBe('The next draft')
})

it('offers the paperclip and dictation on a saved Chief of Staff question', async () => {
    root = createRoot(document.body.appendChild(document.createElement('div')))
    const question = { id: 'a'.repeat(64), messageId: 'saved-question', toolCallId: 'question-call',
        questions: [{ question: 'Which time?', options: ['Morning', 'Afternoon'] }] }
    const answer = vi.fn(async () => {})
    const fetcher = vi.fn(async () => Response.json({ attachments: [] }))
    vi.stubGlobal('fetch', fetcher)
    const sessionId = crypto.randomUUID()
    const render = (hidden = false) => act(async () => root!.render(
        <DesktopForemanColumn chat={chat} ports={ports} live={null} messages={[]} agentNameOf={id => id} sessionId={sessionId}
            controlledOpen hidden={hidden} onClose={() => {}} question={question} onAnswerQuestion={answer} />))
    const record = () => document.querySelector('[data-hitl="record"]')
    await render()
    expect(record()?.getAttribute('aria-label')).toBe('Answer with your voice')
    expect(document.querySelector('[data-hitl="attach"]')).not.toBeNull()
    const query = new URLSearchParams({ tabUid: chat.chatId, sessionId, questionId: question.id })
    expect(fetcher).toHaveBeenCalledWith(`/api/desktop/foreman/document-attachments?${query}`, expect.anything())
    await render(true)
    expect(record()).toBeNull()
    await render()
    expect(record()).not.toBeNull()
    await click('Routines tab')
    expect(record()).toBeNull()
    expect(answer).not.toHaveBeenCalled()
})
