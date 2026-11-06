// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { DesktopWorkspaceRoutinesClient } from '@/lib/desktop/workspace-routines/client'
import type { DesktopWorkspaceRoutine } from '../../../../../../packages/contracts/src/desktop-workspace-routines'
import { DesktopWorkspaceRoutines } from './DesktopWorkspaceRoutines'

vi.mock('@rerun/ui/iso-grid', () => ({ AgentBuddy: () => null }))
const roots: Root[] = []
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterEach(async () => {
    await act(async () => { for (const root of roots.splice(0)) root.unmount() })
    document.body.innerHTML = ''
    vi.restoreAllMocks()
})
const routine: DesktopWorkspaceRoutine = {
    agentId: 'agent-a', slug: 'daily', name: 'Daily', enabled: true, revision: 'v1', frequency: 'Every day at 8:00 AM', nextRunAt: null, runningSince: null, setupPending: false,
    lastRunAt: '2026-11-05T08:00:00.000Z', lastResult: { status: 'done', runId: 'run-a', chat: { agentId: 'agent-a', sessionId: 'chat-a', engineSessionId: 'engine-chat-a', tabUid: 'schedule:chat-a', title: 'Daily result', runId: 'run-a' } },
}
function client(routines: DesktopWorkspaceRoutine[] = [routine]): DesktopWorkspaceRoutinesClient {
    return {
        list: vi.fn(async () => ({ routines, canRename: true }),
        mutate: vi.fn(async () => ({ routine, chat: routine.lastResult!.chat })),
    }
}
async function mount(api = client(), onOpenChat = vi.fn(), onOpenRoutine = vi.fn()) {
    const root = createRoot(document.body.appendChild(document.createElement('div'))); roots.push(root)
    await act(async () => root.render(<DesktopWorkspaceRoutines client={api} agentNameOf={() => 'Ada'} onOpenChat={onOpenChat} onOpenRoutine={onOpenRoutine} docked />))
    return { root, onOpenChat, onOpenRoutine }
}
const click = async (label: string) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === label || item.getAttribute('aria-label') === label)!
    await act(async () => { button.click() })
}

test('renders the original empty state without running anything on mount', async () => {
    const api = client([])
    await mount(api)
    expect(document.body.textContent).toContain('No routines yet')
    expect(api.mutate).not.toHaveBeenCalled()
})

test('Run now opens the exact adopted result chat and never a guessed session', async () => {
    const api = client()
    const { onOpenChat } = await mount(api)
    await click('Daily options')
    await click('Run now')
    expect(api.mutate).toHaveBeenCalledWith(expect.objectContaining({ action: 'run', agentId: 'agent-a', slug: 'daily', expectedRevision: 'v1', requestId: expect.any(String) }))
    expect(onOpenChat).toHaveBeenCalledWith(routine.lastResult!.chat)
})

test('pause failure restores the previous enabled state and keeps the held row visible', async () => {
    const api = client()
    api.mutate = vi.fn(async () => { throw new Error('revision changed') })
    await mount(api)
    await click('Pause Daily')
    expect(document.body.textContent).toContain('Daily')
    expect(api.mutate).toHaveBeenCalledWith(expect.objectContaining({ action: 'toggle', enabled: false, expectedRevision: 'v1' }))
    expect(document.querySelector('[aria-label="Resume Daily"]')).toBeTruthy()
})

test('polling preserves an edited draft and offers refresh choices before saving', async () => {
    const api = client()
    const { root } = await mount(api)
    await click('Daily options')
    await click('Edit')
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Name"]')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'My edited name')
    await act(async () => input.dispatchEvent(new Event('input', { bubbles: true })))
    api.list = vi.fn(async () => ({ routines: [{ ...routine, revision: 'v2', name: 'Latest server name' }], canRename: true }))
    await act(async () => root.render(<DesktopWorkspaceRoutines client={api} agentNameOf={() => 'Ada'} onOpenChat={vi.fn()} onOpenRoutine={vi.fn()} docked refreshKey={2} />))
    expect(input.value).toBe('My edited name')
    expect(document.body.textContent).toContain('This routine changed while you were editing.')
    await click('Refresh from latest')
    expect(document.body.textContent).toContain('Latest server name')
})
