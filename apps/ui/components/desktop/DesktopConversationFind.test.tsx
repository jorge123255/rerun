// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test, vi } from 'vitest'
import type { DesktopFindResult } from '@/lib/desktop/find-in-page'
import { DesktopConversationFind } from './DesktopConversationFind'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

test('shows only the latest Find result and an inactive pane does not clear native Find', async () => {
    const pending: Array<(value: DesktopFindResult) => void> = []
    const findInPage = vi.fn(({ action }: { action: string }) => action === 'stop' ? Promise.resolve({ ok: true })
        : new Promise<DesktopFindResult>(resolve => pending.push(resolve)))
    vi.stubGlobal('desktopApp', { findInPage })
    const activePane = document.body.appendChild(document.createElement('div'))
    const inactivePane = document.body.appendChild(document.createElement('div'))
    const activeRoot = createRoot(activePane), inactiveRoot = createRoot(inactivePane)
    let inactiveMounted = false
    const render = (open: boolean) => act(async () => activeRoot.render(<DesktopConversationFind open={open} onOpenChange={() => {}} />))
    const type = (query: string) => act(async () => {
        const input = activePane.querySelector('input')!
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, query)
        input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    try {
        await render(true)
        await act(async () => inactiveRoot.render(<DesktopConversationFind open={false} onOpenChange={() => {}} />))
        inactiveMounted = true
        await act(async () => inactiveRoot.unmount())
        inactiveMounted = false
        expect(findInPage).not.toHaveBeenCalled()

        await type('first')
        await type('second')
        expect(pending).toHaveLength(2)
        await act(async () => pending[1]({ ok: true, matches: 2, activeMatchOrdinal: 1 }))
        await act(async () => pending[0]({ ok: true, matches: 99, activeMatchOrdinal: 1 }))
        expect(activePane.querySelector('[role="status"]')?.textContent).toBe('1 of 2')
        await render(false)
        expect(findInPage.mock.calls.filter(([input]) => input.action === 'stop')).toHaveLength(1)
    } finally {
        await act(async () => { activeRoot.unmount(); if (inactiveMounted) inactiveRoot.unmount() })
        activePane.remove()
        inactivePane.remove()
        vi.unstubAllGlobals()
    }
})
