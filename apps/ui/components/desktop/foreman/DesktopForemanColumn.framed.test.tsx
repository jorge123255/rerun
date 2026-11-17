// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cancelDraftShutdown } from '@/lib/desktop/draft-writes'
import type { DesktopForemanActionPorts } from '@/lib/desktop/foreman-client'
import { desktopDetailsWanted, setDesktopDetailsWanted } from '@/lib/desktop/simple-details'
type DockBindingInput = Parameters<typeof import('./dock').useDesktopForemanDockBinding>[0]
type DockLayoutProps = ComponentProps<typeof import('./dock').DesktopForemanDockLayout>
vi.mock('./dock', () => ({
    useDesktopForemanDockBinding: (props: DockBindingInput) => ({ scope: '1:chat', placement: props.placement, dock: props.dock, onPlacement: props.setPlacement, onDock: props.setDock }),
    DesktopForemanDockLayout: (props: DockLayoutProps) => <div data-open={String(props.open)}>{props.children({ onPointerDown() {} })}</div>,
    DesktopParkedForeman: () => null,
}))
vi.mock('@rerun/ui/primitives/use-is-mobile', () => ({ useIsMobile: (query?: string) => !!query?.includes('min-width: 1280') && wide }))
const routineMounts: { active: boolean }[] = []
vi.mock('./routines/DesktopWorkspaceRoutines', () => ({ DesktopWorkspaceRoutines: (props: { active?: boolean }) => { routineMounts.push({ active: props.active !== false }); return <div data-routines data-active={String(props.active !== false)}>Routines content</div> } }))
vi.mock('./plan/DesktopPlanBoardPreview', () => ({ DesktopPlanBoardPreview: () => null }))
import { DesktopForemanColumn } from './DesktopForemanColumn'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const chat = { workspaceId: '1', chatId: 'fmc_framed0000001' }
// With a team the empty conversation shows the team welcome, as in the app.
const team = [{ id: 'ada', name: 'Ada QA', handle: null, status: 'idle', disabledAt: null }]
let root: Root | undefined
let ports: DesktopForemanActionPorts
let wide = true
const details = () => document.querySelector<HTMLElement>('section[aria-label="Chief of Staff card"]')!
const pill = () => document.querySelector<HTMLButtonElement>('[data-foreman-top-bar] h1 button')!
beforeEach(() => {
    cancelDraftShutdown(); wide = true; routineMounts.length = 0; setDesktopDetailsWanted(false)
    ports = {
        persistence: { load: vi.fn(async () => null), save: vi.fn(async () => {}) },
        plans: { readShownPlan: vi.fn(async () => null), readConversationView: vi.fn(async () => ({ contractVersion: 1, chat, phase: 'plan', live: null, revisions: [], currentRevisionId: null, decisions: [], build: null, discovery: null, blocked: null })) },
        build: { readProgress: vi.fn(async () => null) }, decisions: { submit: vi.fn() }, discovery: { capabilities: () => ({ available: false }), subscribe: vi.fn() }, navigation: { dispatch: vi.fn() }, conversation: { sendMessage: vi.fn(), stop: vi.fn() }, routines: { list: vi.fn() },
    } as unknown as DesktopForemanActionPorts
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ delegations: [], calls: [], attachments: [] })))
})
afterEach(async () => { if (root) await act(async () => root!.render(null)); if (root) await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ''; cancelDraftShutdown(); vi.unstubAllGlobals(); setDesktopDetailsWanted(false) })
type Props = Partial<ComponentProps<typeof DesktopForemanColumn>>
async function render(props: Props = {}) {
    root ??= createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<DesktopForemanColumn chat={chat} ports={ports} live={null} messages={[]} agentNameOf={id => id} controlledOpen
        team={team} firstName="Sam" separateConversation {...props} />))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
}
const bar = (patch: Partial<NonNullable<Props['framedBar']>> = {}): NonNullable<Props['framedBar']> => ({ history: <button data-history>Conversations</button>, end: <button data-end>More</button>, thread: null, onShowGeneral: vi.fn(), onNewTask: vi.fn(), ...patch })
const box = () => document.querySelector<HTMLTextAreaElement>('textarea[data-desktop-foreman-composer]')!
const topBar = () => document.querySelector<HTMLElement>('[data-foreman-top-bar]')

it('in the middle of the Simple view the Chief of Staff takes the frame a coworker\'s chat has', async () => {
    const framedBar = bar()
    await render({ fill: true, framedBar })
    // No Ask / Routines tabs over the chat: its conversations at the left, its name, then General as a tab.
    expect(document.querySelector('[role="tab"]')).toBeNull()
    const header = topBar()!.querySelector('header')!
    expect(header.firstElementChild!.querySelector('[data-history]')).not.toBeNull()
    expect(header.querySelector('h1')!.textContent).toBe('Chief of Staff')
    expect(pill().getAttribute('aria-label')).toBe('Chief of Staff card')
    expect(header.lastElementChild!.querySelector('[data-end]')).not.toBeNull()
    const general = topBar()!.querySelector<HTMLButtonElement>('[data-general-tab]')!
    expect(general.textContent).toBe('General')
    expect(general.getAttribute('aria-pressed')).toBe('true')
    await act(async () => { topBar()!.querySelector<HTMLButtonElement>('button[aria-label="New task"]')!.click() })
    expect(framedBar.onNewTask).toHaveBeenCalledOnce()
    // The conversation and the composer share a coworker's column; the composer sits under its line and names who it writes to.
    expect(document.querySelector('.max-w-\\[48rem\\].pt-4')).not.toBeNull()
    expect(document.querySelector('.pt-24')).toBeNull()
    expect(box().placeholder).toBe('Message Chief of Staff...')
    expect(box().closest('form')!.className).toContain('max-w-[48rem]')
    expect(box().closest('form')!.parentElement!.className).toContain('border-t')
})

it('the thread on screen is a tab beside General, and the composer replies in it', async () => {
    const framedBar = bar({ thread: { id: chat.chatId, title: 'Fix the docs', state: 'live', named: true } })
    await render({ fill: true, framedBar, headerCrumb: <div data-foreman-thread-crumb>General/Fix the docs</div> })
    const strip = topBar()!.querySelector('[role="group"][aria-label="Open conversations"]')!
    expect(strip.querySelector('[data-general-tab]')!.getAttribute('aria-pressed')).toBe('false')
    const tab = strip.querySelector<HTMLButtonElement>('button[title="Fix the docs"]')!
    expect(tab.getAttribute('aria-pressed')).toBe('true')
    // It answers: the tab carries the green dot. The crumb under the tabs is not drawn twice.
    expect(tab.querySelector('.bg-emerald-400')).not.toBeNull()
    expect(document.querySelector('[data-foreman-thread-crumb]')).toBeNull()
    expect(box().placeholder).toBe('Reply in Fix the docs...')
    await act(async () => { strip.querySelector<HTMLButtonElement>('[data-general-tab]')!.click() })
    await act(async () => { strip.querySelector<HTMLButtonElement>('button[aria-label="Close Fix the docs"]')!.click() })
    expect(framedBar.onShowGeneral).toHaveBeenCalledTimes(2)
    // A task nobody named yet is written to as the Chief of Staff itself.
    await render({ fill: true, framedBar: bar({ thread: { id: chat.chatId, title: 'New task', state: 'quiet', named: false } }) })
    expect(box().placeholder).toBe('Message Chief of Staff...')
})

it('the board\'s floating or docked Chief of Staff keeps its own header', async () => {
    await render({ framedBar: bar() })
    expect(topBar()).toBeNull()
    expect([...document.querySelectorAll('[role="tab"]')].map(tab => tab.textContent)).toEqual(['Ask', 'Routines'])
    expect(document.querySelector('.pt-24')).not.toBeNull()
    expect(box().placeholder).toBe('Send a message...')
})

it('the name opens a panel beside the chat with every routine of the workspace, kept open or closed from a coworker to the Chief of Staff', async () => {
    await render({ fill: true, framedBar: bar() })
    // Closed until asked for: nothing of it is mounted, nothing is read.
    expect(details().hidden).toBe(true)
    expect(routineMounts).toEqual([])
    expect(pill().getAttribute('aria-expanded')).toBe('false')
    await act(async () => { pill().click() })
    expect(desktopDetailsWanted()).toBe(true)
    expect(details().hidden).toBe(false)
    expect(details().dataset.cardBeside).toBe('true')
    expect(pill().getAttribute('aria-expanded')).toBe('true')
    // Who it is, then the routines, in the column a coworker's card has: the chat keeps its room beside it.
    expect(details().textContent).toContain('Chief of StaffAsk anything')
    expect(details().querySelector('h3')!.textContent).toBe('Routines')
    expect(details().querySelector('[data-routines]')!.getAttribute('data-active')).toBe('true')
    expect(details().parentElement!.className).toContain('pr-[26rem]')
    expect(document.querySelector('button[aria-label="Back to the chat"]')).toBeNull()
    // Closed from its own button, it reads nothing while out of sight and stays mounted.
    await act(async () => { details().querySelector<HTMLButtonElement>('button[aria-label="Close the card"]')!.click() })
    expect(desktopDetailsWanted()).toBe(false)
    expect(details().hidden).toBe(true)
    expect(details().querySelector('[data-routines]')!.getAttribute('data-active')).toBe('false')
    expect(details().parentElement!.className).not.toContain('pr-[26rem]')
    // A coworker's card left open is the Chief of Staff's panel open, and the other way round.
    await act(async () => { setDesktopDetailsWanted(true) })
    expect(details().hidden).toBe(false)
    expect(details().querySelector('[data-routines]')!.getAttribute('data-active')).toBe('true')
    // Escape in the panel closes it, as it closes a coworker's card.
    await act(async () => { details().querySelector('h3')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(details().hidden).toBe(true)
})

it('on a narrower window the panel lies over the chat behind a backdrop that closes it; the board\'s Chief of Staff has none', async () => {
    wide = false
    await render({ fill: true, framedBar: bar() })
    await act(async () => { pill().click() })
    expect(details().hidden).toBe(false)
    expect(details().dataset.cardBeside).toBeUndefined()
    expect(details().parentElement!.className).not.toContain('pr-[26rem]')
    await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="Back to the chat"]')!.click() })
    expect(details().hidden).toBe(true)
    expect(desktopDetailsWanted()).toBe(false)
    // Outside the Simple view's middle the routines stay in their tab, and no panel exists even when one is wanted.
    setDesktopDetailsWanted(true)
    await render({ framedBar: bar() })
    expect(document.querySelector('section[aria-label="Chief of Staff card"]')).toBeNull()
    expect([...document.querySelectorAll('[role="tab"]')].map(tab => tab.textContent)).toEqual(['Ask', 'Routines'])
})
