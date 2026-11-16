// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { desktopForemanMessages, type DesktopForemanClientState } from '@/lib/desktop/foreman-client/runtime-client'
import { DesktopForemanChatLayer } from './DesktopForemanChatLayer'
import type { DesktopForemanGeneralThread } from './DesktopForemanConversations'

// The Chief of Staff's tasks inside General, as Rerun Cloud shows them (upstream #201-#203).
vi.mock('./DesktopForemanWelcome', () => ({ DesktopForemanWelcome: () => <div data-test-welcome /> }))
vi.mock('./docs/DesktopForemanDocsTool', () => ({ DesktopForemanDocsTool: () => null }))
vi.mock('./plan/DesktopPlanCard', () => ({ DesktopPlanCard: () => null }))
vi.mock('./DesktopForemanBuildProgress', () => ({ DesktopForemanBuildProgress: () => null }))
vi.mock('./DesktopForemanNextSteps', () => ({ DesktopForemanNextSteps: () => null }))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
type Props = ComponentProps<typeof DesktopForemanChatLayer>
const roots: Root[] = []
afterEach(() => { for (const root of roots.splice(0)) act(() => { root.unmount() }); document.body.innerHTML = '' })

const at = (minute: number) => `2026-11-16T10:${String(minute).padStart(2, '0')}:00.000Z`
const task = (id: string, title: string | null, minute: number): DesktopForemanGeneralThread =>
    ({ chat: { workspaceId: '1', chatId: `fmc_${id}` }, title, createdAt: at(minute), updatedAt: at(minute + 1) })
const messages: Props['messages'] = [
    { id: 'm0', role: 'user', text: 'Plan the launch', createdAt: at(10) },
    { id: 'm1', role: 'assistant', text: 'Here is a plan', createdAt: at(11) },
    { id: 'm2', role: 'user', text: 'Thanks', createdAt: at(30) },
]
const defaults: Props = {
    messages, restored: true, planSnapshot: null, decisionStatus: { status: 'idle' }, build: null, nextSteps: [], leadState: { status: 'idle' },
    onConfirmPlan() {}, onAskChanges() {}, onStartLead() {}, onOpenCreated() {},
}
async function mount(props: Partial<Props>) {
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host); roots.push(root)
    await act(async () => root.render(<DesktopForemanChatLayer {...defaults} {...props} />))
    return host
}
/** The transcript top to bottom: each message by its text, each branch by its task. */
const sequence = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('[data-foreman-thread-branch], [data-test-message]')]
    .map(node => node.dataset.foremanThreadBranch ?? node.dataset.testMessage)
const branchButton = (host: HTMLElement, chatId: string) => host.querySelector<HTMLButtonElement>(`[data-foreman-thread-branch="${chatId}"] button`)!

test('each saved task hangs under the General message it started after, in the order they started', async () => {
    const onOpenThread = vi.fn()
    const threads = [task('late', 'Write the changelog', 45), task('second', 'Pricing page', 20), task('first', 'Launch checklist', 12), task('before', null, 5)]
    const host = await mount({ threads, onOpenThread })
    for (const [index, node] of [...host.querySelectorAll<HTMLElement>('.max-w-\\[95\\%\\]')].entries()) node.dataset.testMessage = messages[index]!.id
    // Before any message, then after the answer at 10:11 (two, by start time), then after 10:30.
    expect(sequence(host)).toEqual(['fmc_before', 'm0', 'm1', 'fmc_first', 'fmc_second', 'm2', 'fmc_late'])
    expect(branchButton(host, 'fmc_first').textContent).toContain('Launch checklist')
    // A task with no title yet is named like the popover names it.
    expect(branchButton(host, 'fmc_before').textContent).toContain('New task')
    await act(async () => { branchButton(host, 'fmc_second').click() })
    expect(onOpenThread).toHaveBeenCalledExactlyOnceWith(threads[1])
})

test('a thread, and a General still restoring, show no branch', async () => {
    const threads = [task('first', 'Launch checklist', 12)]
    expect((await mount({})).querySelector('[data-foreman-thread-branch]')).toBeNull()
    expect((await mount({ threads, restored: false })).querySelector('[data-foreman-thread-branch]')).toBeNull()
})

test('a General nobody wrote in shows its tasks instead of the welcome', async () => {
    const host = await mount({ messages: [], emptyWelcome: true, threads: [task('first', 'Launch checklist', 12)] })
    expect(host.querySelector('[data-foreman-thread-branch="fmc_first"]')).not.toBeNull()
    expect(host.querySelector('[data-test-welcome]')).toBeNull()
    expect((await mount({ messages: [], emptyWelcome: true })).querySelector('[data-test-welcome]')).not.toBeNull()
})

test('a parked column does not open a task from a branch', async () => {
    const onOpenThread = vi.fn()
    const host = await mount({ active: false, threads: [task('first', 'Launch checklist', 12)], onOpenThread })
    await act(async () => { branchButton(host, 'fmc_first').click() })
    expect(onOpenThread).not.toHaveBeenCalled()
})

test('the saved time of a message reaches the transcript, so a branch can be placed', () => {
    const chat = { workspaceId: '1', chatId: 'fmc_abcdefgh' }
    const state = { chat, sessionId: 'session', messages: [
        { id: 'engine-1', role: 'user', parts: [{ type: 'text', text: 'Hello' }], metadata: { createdAt: at(10) } },
        { id: 'engine-2', role: 'assistant', parts: [{ type: 'text', text: 'Hi' }] },
    ] } as unknown as DesktopForemanClientState
    expect(desktopForemanMessages(state).map(message => message.createdAt)).toEqual([at(10), undefined])
})
