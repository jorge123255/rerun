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
vi.mock('./DesktopForemanComposer', () => ({ DesktopForemanComposer: (props: ComposerProps) => <div><textarea data-desktop-foreman-composer aria-label="Message the Foreman" />{props.trailing}{props.controls}</div> }))
vi.mock('./DesktopForemanChatLayer', () => ({ DesktopForemanChatLayer: () => <div>Chat</div> }))
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
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ''; cancelDraftShutdown() })
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
