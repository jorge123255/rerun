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

test('a coworker can open memories, retry and refresh without losing a chat draft', async () => {
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
        expect(dialog()?.querySelector('[aria-label="Delete memory"]')).not.toBeNull()
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

async function enter(id: string, value: string) {
    const field = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement
    expect(field).toBeTruthy()
    await act(async () => {
        const prototype = field.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
        Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(field, value)
        field.dispatchEvent(new Event('input', { bubbles: true }))
    })
}

test('saves trimmed content and metadata, retaining drafts and request IDs across failed saves', async () => {
    const root = mount()
    const writes: { content: string; kind?: string; tags?: string[]; requestId: string }[] = []
    const stored = new Map<string, ReturnType<typeof note>>()
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
        expect(url).toBe('/api/desktop/agents/reviewer/memories')
        if (init.method === 'POST') {
            const input = JSON.parse(String(init.body))
            writes.push(input)
            if (writes.length === 1 || writes.length === 3) return Response.json({ error: 'Save failed. Try again.' }, { status: 503 })
            stored.set(input.requestId, { ...note(input.requestId, input.content), kind: input.kind ?? 'note', tags: input.tags ?? [] })
            return Response.json({ id: input.requestId }, { status: 201 })
        }
        return Response.json({ memories: [...stored.values()] })
    })
    try {
        await act(async () => { root.render(<DesktopCoworkerMemories agent={coworker('reviewer')} />) })
        await click('Memories')
        await click('Add memory')
        await enter('desktop-memory-content', '  Project colors  ')
        await enter('desktop-memory-kind', '  preference ')
        await enter('desktop-memory-tags', ' blue, , navy ')
        await click('Save memory')
        expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe('Save failed. Try again.')
        expect((document.getElementById('desktop-memory-content') as HTMLTextAreaElement).value).toBe('  Project colors  ')
        await click('Save memory')
        expect(writes[1]).toEqual(writes[0])
        expect(writes[1]).toEqual({ content: 'Project colors', kind: 'preference', tags: ['blue', 'navy'], requestId: expect.stringMatching(/^[a-f\d-]{36}$/i) })
        expect(dialog()?.textContent).toContain('Project colors')
        expect(dialog()?.textContent).toContain('#navy')
        expect(document.getElementById('desktop-memory-content')).toBeNull()
        await click('Add memory')
        await enter('desktop-memory-content', 'Original draft')
        await click('Save memory')
        await enter('desktop-memory-content', 'Changed draft')
        await click('Save memory')
        expect(writes[3].requestId).not.toBe(writes[2].requestId)
        expect(writes[3]).toEqual({ content: 'Changed draft', requestId: expect.any(String) })
        expect(dialog()?.textContent).toContain('Changed draft')
    } finally { await act(async () => { root.unmount() }) }
})

test('deletes only the confirmed note, keeps the note on failure and supports cancel', async () => {
    const root = mount()
    const first = note('first', 'Preserve this fact.')
    const second = note('second', 'Remove this note.')
    let stored = [first, second]
    let deletes = 0
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
        if (init.method === 'DELETE') {
            expect(url).toBe('/api/desktop/agents/reviewer/memories/second')
            if (++deletes === 1) return Response.json({ error: 'Delete failed. Try again.' }, { status: 503 })
            stored = [first]
            return new Response(null, { status: 204 })
        }
        return Response.json({ memories: stored })
    })
    const requestDelete = async () => {
        const buttons = dialog()?.querySelectorAll<HTMLButtonElement>('[aria-label="Delete memory"]')
        expect(buttons).toHaveLength(2)
        await act(async () => { buttons![1].click() })
        const confirmation = document.querySelector('[role="alertdialog"]')
        expect(confirmation?.textContent).toContain('Remove this note.')
        expect(confirmation?.textContent).toContain('reviewer')
    }
    try {
        await act(async () => { root.render(<DesktopCoworkerMemories agent={coworker('reviewer')} />) })
        await click('Memories')
        await requestDelete()
        await click('Cancel')
        expect(deletes).toBe(0)
        expect(dialog()?.textContent).toContain(second.content)
        await requestDelete()
        await click('Delete')
        expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe('Delete failed. Try again.')
        expect(dialog()?.textContent).toContain(second.content)
        await requestDelete()
        await click('Delete')
        expect(dialog()?.textContent).toContain(first.content)
        expect(dialog()?.textContent).not.toContain(second.content)
        expect(dialog()?.querySelectorAll('[aria-label="Delete memory"]')).toHaveLength(1)
        expect(deletes).toBe(2)
    } finally { await act(async () => { root.unmount() }) }
})

test('a save finishing after a coworker switch cannot replace the new coworker’s notes or draft', async () => {
    const root = mount()
    let finish!: (response: Response) => void
    const calls: string[] = []
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
        calls.push(`${init.method ?? 'GET'} ${url}`)
        if (init.method === 'POST') return new Promise<Response>(resolve => { finish = resolve })
        return Promise.resolve(Response.json({ memories: url.includes('/second/') ? [note('kept', 'Second coworker note')] : [] }))
    })
    const show = (id: string) => act(async () => { root.render(<DesktopCoworkerMemories agent={coworker(id)} />) })
    try {
        await show('first')
        await click('Memories')
        await click('Add memory')
        await enter('desktop-memory-content', 'First coworker draft')
        await click('Save memory')
        await show('second')
        expect(dialog()?.textContent).toContain('Second coworker note')
        await click('Add memory')
        await enter('desktop-memory-content', 'Second coworker draft')
        await act(async () => { finish(Response.json({ id: 'saved' }, { status: 201 })) })
        expect((document.getElementById('desktop-memory-content') as HTMLTextAreaElement).value).toBe('Second coworker draft')
        expect(dialog()?.textContent).not.toContain('First coworker draft')
        expect(calls).toEqual(['GET /api/desktop/agents/first/memories', 'POST /api/desktop/agents/first/memories', 'GET /api/desktop/agents/second/memories'])
    } finally { await act(async () => { root.unmount() }) }
})

test('an already-deleted note is reconciled from the coworker list without discarding an open draft', async () => {
    const root = mount()
    const survivor = note('other', 'Existing second note')
    let stored = [note('gone', 'Already removed elsewhere'), survivor]
    let reads = 0
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
        if (init.method === 'DELETE') {
            expect(url).toBe('/api/desktop/agents/writer/memories/gone')
            stored = [survivor]
            return Response.json({ error: 'Memory not found' }, { status: 404 })
        }
        reads++
        return Response.json({ memories: stored })
    })
    try {
        await act(async () => { root.render(<DesktopCoworkerMemories agent={coworker('writer')} />) })
        await click('Memories')
        await click('Add memory')
        await enter('desktop-memory-content', 'Draft in progress')
        await act(async () => { dialog()!.querySelector<HTMLButtonElement>('[aria-label="Delete memory"]')!.click() })
        await click('Delete')
        expect(reads).toBe(2)
        expect(dialog()?.textContent).not.toContain('Already removed elsewhere')
        expect(dialog()?.textContent).toContain('Existing second note')
        expect(dialog()?.querySelector('[role="alert"]')).toBeNull()
        expect((document.getElementById('desktop-memory-content') as HTMLTextAreaElement).value).toBe('Draft in progress')
    } finally { await act(async () => { root.unmount() }) }
})
