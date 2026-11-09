// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { foremanHistoryParts } from './parts'
import { DesktopForemanHistoryMessage } from './DesktopForemanHistoryMessage'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('reopening saved history and expanding recorded steps never dispatches an action', async () => {
    const network = vi.fn(() => { throw new Error('No history effects permitted') })
    vi.stubGlobal('fetch', network)
    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host)
    const parts = [{ type: 'text', text: 'Keep this answer' }, { type: 'source-url', url: 'javascript:alert(1)', title: 'Unsafe' }, { type: 'source-url', url: 'https://example.com/docs', title: 'Docs' }, { type: 'tool-call_agent', toolCallId: 'c', state: 'input-available', input: { message: 'Do not send' } }, { type: 'unknown', token: 'PRIVATE' }]
    try {
        await act(async () => root.render(<DesktopForemanHistoryMessage history={foremanHistoryParts("saved", parts)} />))
        const link = host.querySelector('a')!
        expect(link.getAttribute('href')).toBe('https://example.com/docs')
        expect(link.getAttribute('rel')).toContain('noopener')
        await act(async () => host.querySelector('button')?.click())
        expect(host.textContent).toContain('Unknown')
        expect(host.textContent).not.toContain('PRIVATE')
        await act(async () => root.render(null))
        await act(async () => root.render(<DesktopForemanHistoryMessage history={foremanHistoryParts("saved", parts)} />))
        expect(host.textContent).toContain('Keep this answer')
        expect(network).not.toHaveBeenCalled()
    } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() }
})
