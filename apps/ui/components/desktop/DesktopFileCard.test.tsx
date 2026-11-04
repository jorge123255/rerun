// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { DesktopFileCard } from './DesktopFileCard'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.innerHTML = '' })

const card = { kind: 'file' as const, files: [
    { path: 'reports/summary.md', name: 'summary.md', size: 7, scope: 'agent' as const },
    { path: 'reports/notes.txt', name: 'notes.txt', size: 5, scope: 'agent' as const },
] }

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')
const click = async (label: string) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === label || item.textContent?.trim() === label)
    expect(button, label).toBeDefined()
    await act(async () => { button!.click() })
}

async function withCard(action: () => Promise<void>) {
    const root = createRoot(document.body.appendChild(document.createElement('div')))
    try {
        await act(async () => root.render(<DesktopFileCard agentId="agent 1" card={card} />))
        await action()
    } finally { await act(async () => root.unmount()) }
}

function fileReads(reply: (path: string) => Response | Promise<Response>) {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
        const request = new URL(url, 'http://127.0.0.1')
        expect(request.pathname).toBe('/api/desktop/agents/agent%201/files/read')
        expect(init).toEqual({ cache: 'no-store' })
        expect([...request.searchParams.keys()]).toEqual(['path'])
        const path = request.searchParams.get('path')!
        expect(card.files.some(file => file.path === path)).toBe(true)
        return reply(path)
    })
    vi.stubGlobal('fetch', fetcher)
    return fetcher
}

test('draws the original file tiles and keeps them openable for a trusted coworker', async () => {
    const root = createRoot(document.body.appendChild(document.createElement('div')))
    try {
        await act(async () => root.render(<DesktopFileCard agentId="agent-1" card={card} />))
        const tiles = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label^="Open "]'))
        expect(tiles.map(tile => tile.getAttribute('aria-label'))).toEqual(['Open summary.md', 'Open notes.txt'])
        expect(tiles.every(tile => !tile.disabled)).toBe(true)
        expect(document.querySelector('[data-file-card]')).not.toBeNull()
        expect(document.querySelector('a[download]')).toBeNull()
    } finally { await act(async () => root.unmount()) }
})

test('shows the same inert tiles when no trusted coworker id is available', async () => {
    const root = createRoot(document.body.appendChild(document.createElement('div')))
    try {
        await act(async () => root.render(<DesktopFileCard card={card} />))
        const tiles = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label^="Open "]'))
        expect(tiles).toHaveLength(2)
        expect(tiles.every(tile => tile.disabled)).toBe(true)
    } finally { await act(async () => root.unmount()) }
})

test('opens the actual text preview, pages through the card, and never creates a raw download URL', async () => {
    const fetcher = fileReads(path => Response.json({ content: path.endsWith('.md') ? '# Current summary\n<script>literal text</script>' : 'Current notes', truncated: false }))
    await withCard(async () => {
        expect(fetcher).not.toHaveBeenCalled()
        await click('Open summary.md')
        expect(dialog()?.querySelector('h2')?.textContent).toBe('summary.md')
        expect(dialog()?.querySelector('pre')?.textContent).toBe('# Current summary\n<script>literal text</script>')
        expect(dialog()?.querySelector('script')).toBeNull()
        expect(dialog()?.textContent).toContain('1 / 2')
        expect(dialog()?.querySelector('a[download]')).toBeNull()
        expect(dialog()?.querySelector('iframe,img,audio,video')).toBeNull()
        await click('Next attachment')
        expect(dialog()?.querySelector('h2')?.textContent).toBe('notes.txt')
        expect(dialog()?.querySelector('pre')?.textContent).toBe('Current notes')
        expect(dialog()?.textContent).toContain('2 / 2')
        await click('Next attachment')
        expect(dialog()?.querySelector('h2')?.textContent).toBe('summary.md')
        await click('Previous attachment')
        expect(dialog()?.querySelector('h2')?.textContent).toBe('notes.txt')
        expect(fetcher.mock.calls.map(([url]) => new URL(url, 'http://local').searchParams.get('path'))).toEqual([
            'reports/summary.md', 'reports/notes.txt', 'reports/summary.md', 'reports/notes.txt',
        ])
        await click('Close')
        expect(dialog()).toBeNull()
        expect(document.querySelector('[data-file-card]')).not.toBeNull()
    })
})

test('a delayed prior page cannot replace the current file, and closing discards its pending preview', async () => {
    const pending: ((response: Response) => void)[] = []
    fileReads(path => path.endsWith('.md')
        ? new Promise<Response>(resolve => { pending.push(resolve) })
        : Response.json({ content: 'The second file is current', truncated: false }))
    await withCard(async () => {
        await click('Open summary.md')
        expect(pending).toHaveLength(1)
        expect(dialog()?.querySelector('pre')).toBeNull()
        await click('Next attachment')
        expect(dialog()?.querySelector('pre')?.textContent).toBe('The second file is current')
        await act(async () => { pending[0](Response.json({ content: 'Stale first response', truncated: true })) })
        expect(dialog()?.querySelector('h2')?.textContent).toBe('notes.txt')
        expect(dialog()?.querySelector('pre')?.textContent).toBe('The second file is current')
        expect(dialog()?.textContent).not.toContain('Stale first response')
        expect(dialog()?.textContent).not.toContain('256 KB')
        await click('Previous attachment')
        expect(pending).toHaveLength(2)
        await click('Close')
        await click('Open notes.txt')
        await act(async () => { pending[1](Response.json({ content: 'Response from closed preview', truncated: false })) })
        expect(dialog()?.querySelector('h2')?.textContent).toBe('notes.txt')
        expect(dialog()?.querySelector('pre')?.textContent).toBe('The second file is current')
        expect(dialog()?.textContent).not.toContain('Response from closed preview')
    })
})

test('reopening reads current bytes and a deleted file shows unavailable instead of a cached result', async () => {
    let content: string | null = 'First version'
    const fetcher = fileReads(() => content === null
        ? Response.json({ error: 'ENOENT /private/workspace/summary.md' }, { status: 404 })
        : Response.json({ content, truncated: false }))
    await withCard(async () => {
        await click('Open summary.md')
        expect(dialog()?.querySelector('pre')?.textContent).toBe('First version')
        await click('Close')
        content = 'Changed persistent file'
        await click('Open summary.md')
        expect(dialog()?.querySelector('pre')?.textContent).toBe('Changed persistent file')
        await click('Close')
        content = null
        await click('Open summary.md')
        expect(dialog()?.textContent).toContain('This file could not be read')
        expect(dialog()?.querySelector('pre')).toBeNull()
        expect(dialog()?.textContent).not.toMatch(/First version|Changed persistent file|\/private\/workspace/)
        expect(fetcher).toHaveBeenCalledTimes(3)
    })
})

test('a file that grew after its card was recorded shows the Files truncation notice only on that page', async () => {
    fileReads(path => Response.json({ content: path.endsWith('.md') ? 'The available prefix' : 'Complete notes', truncated: path.endsWith('.md') }))
    await withCard(async () => {
        await click('Open summary.md')
        expect(dialog()?.querySelector('pre')?.textContent).toBe('The available prefix')
        expect(dialog()?.querySelector('[role="status"]')?.textContent).toBe('Preview shows the first 256 KB.')
        await click('Next attachment')
        expect(dialog()?.querySelector('pre')?.textContent).toBe('Complete notes')
        expect(dialog()?.querySelector('[role="status"]')).toBeNull()
    })
})
