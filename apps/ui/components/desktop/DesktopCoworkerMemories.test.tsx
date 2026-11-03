// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { DesktopCoworkerMemories } from './DesktopCoworkerMemories'
import { DesktopConversation } from './DesktopConversation'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const coworker = (id: string) => ({ id, name: id, description: '', createdAt: '', updatedAt: '' })
const note = (id: string, content: string) => ({ id, content, kind: 'fact', tags: ['project'], createdAt: '2026-11-03T08:00:00Z', strength: 0.64, status: 'dormant' })
const dialog = () => document.querySelector('[role="dialog"]')
const click = async (text: string) => {
    const button = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === text)
    expect(button).toBeDefined()
    await act(async () => { button!.click() })
}
function mount() {
    const container = document.createElement('div')
    document.body.append(container)
    return createRoot(container)
}

afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = '' })

test('a coworker can open read-only memories, retry and refresh without losing a chat draft', async () => {
    const root = mount()
    let finish!: (response: Response) => void
    const fetcher = vi.fn()
        .mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve }))
        .mockResolvedValueOnce(Response.json({ memories: [note('one', 'Keeps weekly notes.')] }))
        .mockResolvedValueOnce(Response.json({ memories: [] }))
    vi.stubGlobal('fetch', fetcher)
    try {
        await act(async () => { root.render(<DesktopConversation agent={coworker('local-id')} sessionId={null} sessions={[]} onSelectSession={() => {}} onChatSession={() => {}} />) })
        const input = document.querySelector<HTMLTextAreaElement>('#desktop-message')!
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Unsent question')
            input.dispatchEvent(new Event('input', { bubbles: true }))
        })
        await click('Memories')
        expect(dialog()?.textContent).toContain('Loading memories…')
        await act(async () => { finish(Response.json({ error: 'unavailable' }, { status: 502 })) })
        expect(dialog()?.querySelector('[role="alert"]')).not.toBeNull()
        expect(dialog()?.textContent).not.toContain('No memories yet')
        await click('Retry')
        for (const label of ['Keeps weekly notes.', 'fact', 'dormant', '64%', '#project']) expect(dialog()?.textContent).toContain(label)
        expect(dialog()?.querySelector('[aria-label="Delete memory"]')).toBeNull()
        await click('Refresh')
        expect(dialog()?.textContent).toContain('No memories yet')
        await click('Done')
        expect(dialog()).toBeNull()
        expect(document.querySelector('#desktop-message')).toBe(input)
        expect(input.value).toBe('Unsent question')
        expect(fetcher.mock.calls.map(([url, init]) => [url, init.method ?? 'GET'])).toEqual(Array.from({ length: 3 }, () => ['/api/desktop/agents/local-id/memories', 'GET']))
    } finally { await act(async () => { root.unmount() }) }
})

test('late responses from another coworker or a closed dialog never populate a newly opened view', async () => {
    const root = mount()
    const reads: { url: string; signal: AbortSignal; finish(response: Response): void }[] = []
    vi.stubGlobal('fetch', (url: string, { signal }: RequestInit) => new Promise<Response>(finish => { reads.push({ url, signal: signal!, finish }) }))
    const render = (id: string) => act(async () => { root.render(<DesktopCoworkerMemories agent={coworker(id)} />) })
    try {
        await render('researcher')
        await click('Memories')
        await render('reviewer')
        expect(reads[0].signal.aborted).toBe(true)
        expect(reads[1].url).toBe('/api/desktop/agents/reviewer/memories')
        await act(async () => { reads[0].finish(Response.json({ memories: [note('r', 'Another coworker’s memory')] })) })
        expect(dialog()?.textContent).toContain('Loading memories…')
        await click('Done')
        expect(reads[1].signal.aborted).toBe(true)
        await click('Memories')
        await act(async () => { reads[1].finish(Response.json({ memories: [note('old', 'Outdated memory')] })) })
        expect(dialog()?.textContent).toContain('Loading memories…')
        await act(async () => { reads[2].finish(Response.json({ memories: [note('new', 'Current memory')] })) })
        expect(dialog()?.textContent).toContain('Current memory')
        expect(dialog()?.textContent).not.toMatch(/Another coworker’s memory|Outdated memory/)
    } finally { await act(async () => { root.unmount() }) }
})
