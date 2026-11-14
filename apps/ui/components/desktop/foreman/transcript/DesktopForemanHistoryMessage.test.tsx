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
    const parts = [
        { type: 'text', text: 'Keep this answer' },
        { type: 'source-url', url: 'javascript:alert(1)', title: 'Unsafe' },
        { type: 'source-url', url: 'https://example.com/docs', title: 'Docs' },
        { type: 'tool-call_agent', toolCallId: 'c', state: 'input-available', input: { message: 'Do not send' } },
        { type: 'tool-agent_files_list', toolCallId: 'file', state: 'output-error', errorText: 'PRIVATE' },
        { type: 'unknown', token: 'PRIVATE' },
    ]
    try {
        await act(async () => root.render(<DesktopForemanHistoryMessage history={foremanHistoryParts("saved", parts)} />))
        const link = host.querySelector('a')!
        expect(link.getAttribute('href')).toBe('https://example.com/docs')
        expect(link.getAttribute('rel')).toContain('noopener')
        const disclosure = host.querySelector<HTMLButtonElement>('button[aria-expanded]')
        expect(disclosure?.getAttribute('aria-label')).toBe('2 steps, 1 failed, 1 unknown')
        await act(async () => disclosure?.click())
        expect(host.textContent).toContain('Unknown')
        expect(host.textContent).toContain('Failed')
        expect(host.textContent).not.toContain('PRIVATE')
        await act(async () => root.render(null))
        await act(async () => root.render(<DesktopForemanHistoryMessage history={foremanHistoryParts("saved", parts)} />))
        expect(host.textContent).toContain('Keep this answer')
        expect(network).not.toHaveBeenCalled()
    } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() }
})

it('rehydrates Markdown answers, reasoning and documentation at their saved positions', async () => {
    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host)
    const history: import('./parts').ForemanHistoryPart[] = [
        { key: 'answer', kind: 'text', text: '## Saved heading\n\n**Bold answer**\n\n- First item\n- Second item\n\n```text\nliteral code\n```' },
        { key: 'reason', kind: 'reasoning', text: '**Saved reasoning** with `inline code`' },
        { key: 'sources', kind: 'docs', note: '*Recorded note*', links: [{ url: 'https://example.com/docs', title: 'Recorded source', text: '**Passage text**' }] },
        { key: 'last', kind: 'text', text: 'Last answer [unfinished' },
    ]
    const render = () => <DesktopForemanHistoryMessage history={JSON.parse(JSON.stringify(history))} />
    try {
        await act(async () => root.render(render()))
        expect(host.querySelector('h2')?.textContent).toBe('Saved heading')
        expect(host.querySelectorAll('li')).toHaveLength(2)
        expect(host.querySelector('pre')?.textContent).toContain('literal code')
        expect(host.querySelector('details [data-streamdown=strong]')?.textContent).toBe('Saved reasoning')
        expect(host.querySelector('a')?.textContent).toContain('Recorded source')
        const before = host.textContent!
        expect(before.indexOf('Saved heading')).toBeLessThan(before.indexOf('Saved reasoning'))
        expect(before.indexOf('Passage text')).toBeLessThan(before.indexOf('Last answer'))
        expect(before).toContain('[unfinished')
        await act(async () => root.render(null))
        await act(async () => root.render(render()))
        expect(host.textContent).toBe(before)
    } finally { await act(async () => root.unmount()); host.remove() }
})

it('keeps active URLs, embedded content and forged source links inert while retaining cards', async () => {
    const fetchSpy = vi.fn(() => { throw new Error('No network') })
    vi.stubGlobal('fetch', fetchSpy)
    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host)
    const history = foremanHistoryParts('saved', [
        { type: 'text', text: '**Safe** [external](https://example.com/ok) [bad](javascript:alert) [relative](/api/desktop/send)\n\n![Remote image](https://example.com/tracker.png)\n\n<iframe src="https://example.com/embed"></iframe>' },
        { type: 'tool-notify_user', toolCallId: 'notice', state: 'output-available', input: { message: 'Recorded notification' }, output: 'Notification sent to the user.' },
    ])
    history.push({ key: 'forged-source', kind: 'link', url: 'javascript:alert(1)', title: 'Inert source' })
    try {
        await act(async () => root.render(<DesktopForemanHistoryMessage history={history} />))
        expect(host.querySelectorAll('img,iframe,video,audio,script')).toHaveLength(0)
        for (const a of host.querySelectorAll('a')) {
            expect(a.getAttribute('href')).toBe('https://example.com/ok')
            expect(a.getAttribute('rel')).toContain('noopener')
        }
        expect(host.querySelector('[data-streamdown=strong]')?.textContent).toBe('Safe')
        expect(host.textContent).toContain('Remote image')
        expect(host.textContent).toContain('Inert source')
        expect(host.querySelector('[data-historical="notification"]')).not.toBeNull()
        expect(fetchSpy).not.toHaveBeenCalled()
    } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() }
})
