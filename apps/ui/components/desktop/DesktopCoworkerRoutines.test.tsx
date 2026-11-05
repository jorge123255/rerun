// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
const panels = vi.hoisted(() => ({ callbacks: [] as Array<(chat: { agentId: string; sessionId: string; title?: string }) => void> }))
vi.mock('./schedules/DesktopCoworkerSchedules', () => ({ DesktopCoworkerSchedules: (props: { onOpenSession: (chat: { agentId: string; sessionId: string; title?: string }) => void }) => { panels.callbacks.push(props.onOpenSession); return <div>Routine list</div> } }))
import { DesktopCoworkerRoutines } from './DesktopCoworkerRoutines'
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => { document.body.innerHTML = ''; panels.callbacks.length = 0 })

test('only the current open owner can open a local result chat; closed and previous-cycle callbacks cannot navigate', async () => {
    const element = document.createElement('div'); document.body.append(element)
    const root = createRoot(element), onOpenChat = vi.fn(), onOpenChange = vi.fn()
    const agent = { id: 'alice', name: 'Alice', description: '', createdAt: '', updatedAt: '' }
    const render = (open: boolean, id = 'alice') => act(async () => { root.render(<DesktopCoworkerRoutines agent={{ ...agent, id }} dialogControl={{ open, onOpenChange }} onOpenChat={onOpenChat} />) })
    try {
        await render(true)
        expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Routines')
        const first = panels.callbacks.at(-1)!
        await render(false); await render(true)
        await act(async () => { first({ agentId: 'alice', sessionId: 'old-session' }) })
        expect(onOpenChat).not.toHaveBeenCalled()
        const second = panels.callbacks.at(-1)!
        await render(true, 'bob'); await render(true)
        await act(async () => { second({ agentId: 'alice', sessionId: 'old-alice' }) })
        expect(onOpenChat).not.toHaveBeenCalled()
        const current = panels.callbacks.at(-1)!
        await act(async () => { current({ agentId: 'bob', sessionId: 'wrong-owner' }); current({ agentId: 'alice', sessionId: 'local-result', title: 'Routine result' }); current({ agentId: 'alice', sessionId: 'repeated' }) })
        expect(onOpenChat).toHaveBeenCalledExactlyOnceWith('local-result', 'Routine result')
        expect(onOpenChange).toHaveBeenCalledWith(false)
    } finally { await act(async () => { root.unmount() }) }
})
