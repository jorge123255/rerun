// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cancelDraftShutdown } from '@/lib/desktop/draft-writes'
import { DEFAULT_DESKTOP_FOREMAN_PLACEMENT, type DesktopForemanActionPorts } from '@/lib/desktop/foreman-client'
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
const chat = { workspaceId: '1', chatId: 'fmc_cloudlook0001' }
const team = [{ id: 'ada', name: 'Ada QA', handle: null, status: 'idle', disabledAt: null }]
let root: Root | undefined
let ports: DesktopForemanActionPorts
beforeEach(() => {
    cancelDraftShutdown()
    ports = {
        persistence: { load: vi.fn(async () => null), save: vi.fn(async () => {}) },
        plans: { readShownPlan: vi.fn(async () => null), readConversationView: vi.fn(async () => ({ contractVersion: 1, chat, phase: 'plan', live: null, revisions: [], currentRevisionId: null, decisions: [], build: null, discovery: null, blocked: null })) },
        build: { readProgress: vi.fn(async () => null) }, decisions: { submit: vi.fn() }, discovery: { capabilities: () => ({ available: false }), subscribe: vi.fn() }, navigation: { dispatch: vi.fn() }, conversation: { sendMessage: vi.fn(), stop: vi.fn() }, routines: { list: vi.fn() },
    } as unknown as DesktopForemanActionPorts
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ delegations: [], calls: [], attachments: [] })))
})
afterEach(async () => { if (root) await act(async () => root!.render(null)); if (root) await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ''; cancelDraftShutdown(); vi.unstubAllGlobals() })
async function render(props: Partial<ComponentProps<typeof DesktopForemanColumn>> = {}) {
    root ??= createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<DesktopForemanColumn chat={chat} ports={ports} live={null} messages={[]} agentNameOf={id => id} controlledOpen
        team={team} firstName="Sam" separateConversation {...props} />))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
}
const tabs = () => [...document.querySelectorAll('[role="tab"]')].map(tab => tab.textContent)

it('greets an empty new task with the cloud\'s team welcome under « Ask »', async () => {
    await render({ sessionId: 'engine-session', intakeFinished: false })
    expect(tabs()).toEqual(['Ask', 'Routines'])
    expect(document.body.textContent).toContain("Hi Sam, I'm your Chief of Staff. Here is your team.")
    expect(document.body.textContent).toContain('1 coworker')
    expect([...document.querySelectorAll('button')].filter(button => /^(What did Ada QA do today\?|Give Ada QA a task|Build a new coworker)/.test(button.textContent ?? ''))).toHaveLength(3)
    expect(document.querySelector<HTMLTextAreaElement>('textarea[data-desktop-foreman-composer]')?.placeholder).toBe('Send a message...')
})

it('offers GitHub projects on the welcome: the choice starts the sentence, and links in the box say they will be read', async () => {
    await render({ sessionId: 'engine-session' })
    const choice = [...document.querySelectorAll('button')].find(button => /^Build a team from GitHub projects/.test(button.textContent ?? ''))!
    expect(choice.textContent).toContain('private ones too')
    expect(document.querySelector('[data-foreman-github-hint]')).toBeNull()
    await act(async () => choice.click())
    const box = document.querySelector<HTMLTextAreaElement>('textarea[data-desktop-foreman-composer]')!
    expect(box.value).toBe('Build a team for these GitHub projects: ')
    // Nothing was sent, and nothing is said until a link is in the box.
    expect(ports.conversation.sendMessage).not.toHaveBeenCalled()
    expect(document.querySelector('[data-foreman-github-hint]')).toBeNull()
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'Build a team for these GitHub projects: https://github.com/acme/web https://github.com/acme/api')
        box.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(document.querySelector('[data-foreman-github-hint]')!.textContent).toContain('2 GitHub repositories will be read when you send')
})

it('offers to set the team up on the welcome once there are coworkers: one tap sends the request', async () => {
    await render({ sessionId: 'engine-session' })
    const choice = [...document.querySelectorAll('button')].find(button => /^Set up my team/.test(button.textContent ?? ''))
    expect(choice!.textContent).toContain('Models, permissions and setup')
    await act(async () => choice!.click())
    expect(ports.conversation.sendMessage).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(vi.mocked(ports.conversation.sendMessage).mock.calls[0])).toContain('Set up my team: walk me through the models, permissions and setup')
})

it('keeps the team welcome on an empty task even where the template library is wired and the company questions never ran', async () => {
    await render({ onReviewTemplate: vi.fn(), intakeFinished: false })
    expect(document.body.textContent).toContain("Hi Sam, I'm your Chief of Staff. Here is your team.")
    expect(document.querySelector('[data-desktop-starter-pack]')).toBeNull()
})

it('puts the thread crumb on its own row under the tabs and lowers the first message under it', async () => {
    await render({ headerCrumb: <div data-foreman-thread-crumb>General/New task</div> })
    const crumb = document.querySelector('[data-foreman-thread-crumb]')!
    expect(crumb.previousElementSibling?.querySelector('[role="tablist"]')).not.toBeNull()
    expect(document.querySelector('.pt-\\[8\\.5rem\\]')).not.toBeNull()
    await act(async () => { [...document.querySelectorAll<HTMLElement>('[role="tab"]')][1]!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })) })
    expect(document.querySelector('[data-foreman-thread-crumb]')).toBeNull()
})

it('moves the column from the header menu and hides the menu where its place is fixed', async () => {
    await render()
    const move = document.querySelector<HTMLButtonElement>('button[aria-label="Move the chat"]')!
    move.focus()
    await act(async () => { move.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
    const choices = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
    expect(choices.map(choice => [choice.textContent, choice.getAttribute('aria-checked')])).toEqual([['Dock left', 'false'], ['Dock right', 'true'], ['Float', 'false']])
    await act(async () => { choices[2]!.click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
    expect(ports.persistence.save).toHaveBeenLastCalledWith(expect.objectContaining({
        placement: { ...DEFAULT_DESKTOP_FOREMAN_PLACEMENT, mode: 'float', corner: 'bottom-right', side: undefined },
    }))
    await render({ fill: true })
    expect(document.querySelector('button[aria-label="Move the chat"]')).toBeNull()
})

it('lets the microphone take the send button\'s place only while the composer is empty', async () => {
    const mic = <button type="button" data-foreman-voice-mic>Hold to talk</button>
    await render({ voiceSlot: mic, voiceMic: true })
    expect(document.querySelector('[data-foreman-voice-mic]')).not.toBeNull()
    expect(document.querySelector('form button[type="submit"]')).toBeNull()
    const composer = document.querySelector<HTMLTextAreaElement>('textarea[data-desktop-foreman-composer]')!
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(composer, 'Hello')
        composer.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(document.querySelector('form button[type="submit"]')).not.toBeNull()
    await render({ voiceSlot: mic, voiceMic: false })
    expect(document.querySelector('form button[type="submit"]')).not.toBeNull()
})
