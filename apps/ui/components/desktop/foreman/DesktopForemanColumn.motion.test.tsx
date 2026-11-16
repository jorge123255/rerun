// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cancelDraftShutdown } from '@/lib/desktop/draft-writes'
import type { DesktopForemanActionPorts } from '@/lib/desktop/foreman-client'
import { desktopForemanSpeechScope, desktopSpeechKey, desktopSpeechPlayer } from '@/lib/desktop/speech-player'
import { resetDesktopArrivalsForTest } from '../panel-motion/DesktopArrive'
type DockBindingInput = Parameters<typeof import('./dock').useDesktopForemanDockBinding>[0]
type DockLayoutProps = ComponentProps<typeof import('./dock').DesktopForemanDockLayout>
vi.mock('./dock', () => ({
    useDesktopForemanDockBinding: (props: DockBindingInput) => ({ scope: '1:chat', placement: props.placement, dock: props.dock, onPlacement: props.setPlacement, onDock: props.setDock }),
    DesktopForemanDockLayout: (props: DockLayoutProps) => <div data-open={String(props.open)}>{props.children({ onPointerDown() {} })}</div>,
    DesktopParkedForeman: () => null,
}))
vi.mock('@rerun/ui/primitives/use-is-mobile', () => ({ useIsMobile: () => false }))
vi.mock('./routines/DesktopWorkspaceRoutines', () => ({ DesktopWorkspaceRoutines: () => <div>Routines content</div> }))
vi.mock('./plan/DesktopPlanBoardPreview', () => ({ DesktopPlanBoardPreview: () => null }))
import { DesktopForemanColumn } from './DesktopForemanColumn'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const chat = { workspaceId: '1', chatId: 'fmc_motion000001' }
const team = [{ id: 'ada', name: 'Ada QA', handle: null, status: 'idle', disabledAt: null }]
const saved = [{ id: 'm1', role: 'user' as const, text: 'A saved message' }]
const approval = { id: 'a'.repeat(64), messageId: 'saved-approval', toolCallId: 'review-call', approvals: [{ action: 'Open the synthetic report' }] }
const question = { id: 'b'.repeat(64), messageId: 'saved-question', toolCallId: 'question-call', questions: [{ question: 'Which time?', options: ['Morning', 'Afternoon'] }] }
let root: Root | undefined
let ports: DesktopForemanActionPorts
beforeEach(() => {
    cancelDraftShutdown(); resetDesktopArrivalsForTest()
    ports = {
        persistence: { load: vi.fn(async () => null), save: vi.fn(async () => {}) },
        plans: { readShownPlan: vi.fn(async () => null), readConversationView: vi.fn(async () => ({ contractVersion: 1, chat, phase: 'plan', live: null, revisions: [], currentRevisionId: null, decisions: [], build: null, discovery: null, blocked: null })) },
        build: { readProgress: vi.fn(async () => null) }, decisions: { submit: vi.fn() }, discovery: { capabilities: () => ({ available: false }), subscribe: vi.fn() }, navigation: { dispatch: vi.fn() }, conversation: { sendMessage: vi.fn(), stop: vi.fn() }, routines: { list: vi.fn() },
    } as unknown as DesktopForemanActionPorts
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ delegations: [], calls: [], attachments: [] })))
})
afterEach(async () => { desktopSpeechPlayer.stop(); if (root) await act(async () => root!.render(null)); if (root) await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ''; cancelDraftShutdown(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
const wait = (ms: number) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) })
async function render(props: Partial<ComponentProps<typeof DesktopForemanColumn>> = {}) {
    root ??= createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<DesktopForemanColumn chat={chat} ports={ports} live={null} messages={saved} agentNameOf={id => id} controlledOpen
        separateConversation {...props} />))
    await wait(5)
}
const orb = (role: string) => document.querySelector<HTMLElement>(`[data-foreman-orb-role="${role}"]`)
const arrived = () => [...document.querySelectorAll<HTMLElement>('[data-desktop-arrive]')].map(node => node.dataset.desktopArrive)

it('shows one mood on the header orb: thinking, answering, recording the person, waiting on them, or at rest', async () => {
    await render()
    expect(orb('welcome')).toBeNull()
    expect(orb('header')!.dataset.orbMood).toBe('idle')
    expect(orb('header')!.hasAttribute('data-orb-still')).toBe(false)
    await render({ orbState: 'thinking', streaming: true })
    expect(orb('header')!.dataset.orbMood).toBe('thinking')
    await render({ orbState: 'speaking', streaming: true })
    expect(orb('header')!.dataset.orbMood).toBe('answering')
    await render({ voiceRecording: true })
    expect(orb('header')!.dataset.orbMood).toBe('recording')
    await render({ approval, onDecideApproval: async () => {} })
    expect(orb('header')!.dataset.orbMood).toBe('waiting')
    // A hidden panel shows nothing of it.
    await render({ approval, onDecideApproval: async () => {}, voiceRecording: true, hidden: true })
    expect(orb('header')!.dataset.orbMood).toBe('idle')
})

it('pulses while a reply of this conversation is read aloud, and not for another conversation\'s voice', async () => {
    await render()
    const speaking = (key: string) => vi.spyOn(desktopSpeechPlayer, 'snapshot').mockReturnValue({ key, phase: 'playing', error: null, truncated: null })
    const mine = speaking(desktopSpeechKey(desktopForemanSpeechScope(chat.workspaceId), chat.chatId, 'engine-1'))
    await render({ focusRequest: 'again' })
    expect(orb('header')!.dataset.orbMood).toBe('reading')
    mine.mockRestore()
    speaking(desktopSpeechKey('app-scout', 'other-session', 'engine-2'))
    await render({ focusRequest: 'once-more' })
    expect(orb('header')!.dataset.orbMood).toBe('idle')
})

it('lets the large orb of an empty task lead, with the header orb still, and fades the welcome in', async () => {
    await render({ messages: [], team, firstName: 'Sam', orbState: 'thinking' })
    expect(document.body.textContent).toContain("Hi Sam, I'm your Chief of Staff. Here is your team.")
    expect(orb('welcome')!.hasAttribute('data-orb-still')).toBe(false)
    expect(orb('header')!.hasAttribute('data-orb-still')).toBe(true)
    expect(orb('welcome')!.dataset.orbMood).toBe(orb('header')!.dataset.orbMood)
    const welcome = orb('welcome')!.closest<HTMLElement>('.animate-in')!
    for (const name of ['fade-in-0', 'slide-in-from-bottom-2', 'duration-300', 'motion-reduce:animate-none']) expect(welcome.classList.contains(name)).toBe(true)
    // The first message takes the welcome away: the header orb takes over.
    await render({ messages: saved, team, firstName: 'Sam' })
    expect(orb('welcome')).toBeNull()
    expect(orb('header')!.hasAttribute('data-orb-still')).toBe(false)
})

it('draws a request saved with the conversation settled, and one that comes while it is open slides in', async () => {
    await render({ approval, onDecideApproval: async () => {} })
    expect(document.body.textContent).toContain('Open the synthetic report')
    expect(arrived()).toEqual(['settled'])
    // Answered and gone; a moment later a question arrives live.
    await render()
    await wait(450)
    await render({ question, onAnswerQuestion: async () => {} })
    expect(document.body.textContent).toContain('Which time?')
    expect(arrived()).toEqual(['live'])
    const card = document.querySelector<HTMLElement>('[data-desktop-arrive]')!
    expect(card.classList.contains('motion-reduce:animate-none')).toBe(true)
    // Its answers are in the page from the first frame: nothing waits for the slide.
    expect(card.textContent).toContain('Morning')
    expect(card.querySelector('[inert], [aria-hidden="true"][data-desktop-arrive]')).toBeNull()
})

it('does not replay a request when the panel is hidden and shown again', async () => {
    await render()
    await wait(450)
    await render({ approval, onDecideApproval: async () => {} })
    expect(arrived()).toEqual(['live'])
    await render({ approval, onDecideApproval: async () => {}, hidden: true })
    await render()
    await wait(450)
    await render({ approval, onDecideApproval: async () => {} })
    expect(arrived()).toEqual(['settled'])
})
