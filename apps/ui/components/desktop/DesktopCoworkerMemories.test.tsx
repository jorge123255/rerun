// @vitest-environment happy-dom
import { desktopBackgroundRead } from '@/test/desktop-background-fixture'
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
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => url === '/api/desktop/agents/local-id/model'
        ? Promise.resolve(Response.json({ error: 'No test model' }, { status: 404 }))
        : desktopBackgroundRead(url, init) ?? fetcher(url, init))
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

test('recalls by submitted query, retries an error, and updates matching results after note changes', async () => {
    const root = mount()
    const url = '/api/desktop/agents/reviewer/memories'
    const outside = note('outside', 'Vacation dates')
    let notes = [outside]
    const queries: string[] = []
    vi.stubGlobal('fetch', async (target: string, init: RequestInit) => {
        if (target === url + '/recall') {
            expect(init.method).toBe('POST')
            const { query } = JSON.parse(String(init.body))
            queries.push(query)
            if (queries.length === 1) return Response.json({}, { status: 502 })
            return Response.json({ memories: notes.filter(n => n.content.includes(query)) })
        }
        if (init.method === 'POST') {
            expect(target).toBe(url)
            const { requestId, content } = JSON.parse(String(init.body))
            notes.push(note(requestId, content))
            return Response.json({ id: requestId }, { status: 201 })
        }
        if (init.method === 'DELETE') {
            expect(target).toBe(url + '/' + notes[1].id)
            notes = [outside]
            return new Response(null, { status: 204 })
        }
        expect(target).toBe(url)
        return Response.json({ memories: notes })
    })
    try {
        await act(async () => { root.render(<DesktopCoworkerMemories agent={coworker('reviewer')} />) })
        await click('Memories')
        await click('Add memory')
        await enter('desktop-memory-content', 'indigo test card')
        await enter('desktop-memory-search', '  indigo  ')
        await act(async () => { dialog()!.querySelector<HTMLFormElement>('form[role="search"]')!.requestSubmit() })
        expect(dialog()?.textContent).toContain('Could not search memories.')
        expect(dialog()?.textContent).not.toContain('No matches')
        await click('Retry')
        expect(dialog()?.textContent).toContain('No matches')
        expect(dialog()?.textContent).toContain('0 recalled for “indigo”')
        expect((document.getElementById('desktop-memory-content') as HTMLTextAreaElement).value).toBe('indigo test card')
        await click('Save memory')
        expect(dialog()?.textContent).toContain('1 recalled for “indigo”')
        expect(dialog()?.textContent).toContain('indigo test card')
        expect(dialog()?.textContent).not.toContain(outside.content)
        await act(async () => { dialog()!.querySelector<HTMLButtonElement>('[aria-label="Delete memory"]')!.click() })
        await click('Delete')
        expect(dialog()?.textContent).toContain('No matches')
        expect(queries).toEqual(['indigo', 'indigo', 'indigo', 'indigo'])
        await click('Clear search')
        expect(dialog()?.textContent).toContain(outside.content)
        expect(dialog()?.textContent).not.toContain('recalled for')
    } finally { await act(async () => { root.unmount() }) }
})

test('late search results cannot replace a new query or the full list after clearing search', async () => {
    const root = mount()
    const reads: { signal: AbortSignal; finish: (r: Response) => void }[] = []
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => url.endsWith('/recall')
        ? new Promise<Response>(finish => { reads.push({ signal: init.signal!, finish }) })
        : Promise.resolve(Response.json({ memories: [note('full', 'Full list note')] })))
    try {
        await act(async () => { root.render(<DesktopCoworkerMemories agent={coworker('reviewer')} />) })
        await click('Memories')
        await enter('desktop-memory-search', 'old')
        await click('Search')
        expect(dialog()?.textContent).toContain('Searching memories…')
        await enter('desktop-memory-search', 'current')
        await click('Search')
        expect(reads[0].signal.aborted).toBe(true)
        await act(async () => { reads[1].finish(Response.json({ memories: [note('current', 'Current ranked match')] })) })
        await act(async () => { reads[0].finish(Response.json({ memories: [note('old', 'Wrong result')] })) })
        expect(dialog()?.textContent).toContain('Current ranked match')
        expect(dialog()?.textContent).not.toContain('Wrong result')
        await click('Refresh')
        await click('Clear search')
        expect(reads[2].signal.aborted).toBe(true)
        await act(async () => { reads[2].finish(Response.json({ memories: [note('old', 'Wrong result')] })) })
        expect(dialog()?.textContent).toContain('Full list note')
        expect(dialog()?.textContent).not.toContain('Wrong result')
    } finally { await act(async () => { root.unmount() }) }
})

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

test('cancel keeps every note and the search, and confirming clears all notes beyond the search', async () => {
    const root = mount()
    const url = '/api/desktop/agents/reviewer/memories'
    const outside = note('outside', 'Vacation dates in July')
    const apple = note('apples', 'Buys apples weekly')
    const cider = note('cider', 'Presses cider from apples')
    let stored = [outside, apple, cider]
    const calls: string[] = []
    vi.stubGlobal('fetch', async (target: string, init: RequestInit) => {
        calls.push(`${init.method ?? 'GET'} ${target}`)
        if (init.method === 'DELETE' && target === url) {
            stored = []
            return new Response(null, { status: 204 })
        }
        if (target === url + '/recall') {
            const { query } = JSON.parse(String(init.body))
            return Response.json({ memories: stored.filter(n => n.content.includes(query)) })
        }
        return Response.json({ memories: stored })
    })
    const trash = () => document.querySelector<HTMLButtonElement>('[aria-label="Clear all memories"]')
    try {
        await act(async () => { root.render(<DesktopCoworkerMemories agent={coworker('reviewer')} />) })
        await click('Memories')
        for (const label of ['Vacation dates in July', 'Buys apples weekly', 'Presses cider from apples']) expect(dialog()?.textContent).toContain(label)
        expect(trash()).not.toBeNull()
        await enter('desktop-memory-search', 'apples')
        await act(async () => { dialog()!.querySelector<HTMLFormElement>('form[role="search"]')!.requestSubmit() })
        expect(dialog()?.textContent).toContain('2 recalled for “apples”')
        expect(dialog()?.textContent).not.toContain('Vacation dates in July')
        await act(async () => { trash()!.click() })
        const confirmation = document.querySelector('[role="alertdialog"]')
        expect(confirmation?.textContent).toContain('Clear all memories?')
        expect(confirmation?.textContent).toContain("This permanently deletes all of this coworker's memories. This cannot be undone.")
        await click('Cancel')
        expect(document.querySelector('[role="alertdialog"]')).toBeNull()
        expect(calls.filter(call => call.startsWith('DELETE'))).toEqual([])
        expect(stored).toHaveLength(3)
        expect(dialog()?.textContent).toContain('2 recalled for “apples”')
        expect(dialog()?.textContent).toContain('Buys apples weekly')
        expect((document.getElementById('desktop-memory-search') as HTMLInputElement).value).toBe('apples')
        await act(async () => { trash()!.click() })
        await click('Clear all')
        expect(calls).toContain('DELETE /api/desktop/agents/reviewer/memories')
        expect(calls.filter(call => call.startsWith('DELETE'))).toHaveLength(1)
        expect(stored).toEqual([])
        expect(dialog()?.textContent).toContain('No memories yet')
        expect(dialog()?.textContent).not.toContain('recalled for')
        expect((document.getElementById('desktop-memory-search') as HTMLInputElement).value).toBe('')
        expect(document.querySelector('[aria-label="Clear all memories"]')).toBeNull()
    } finally { await act(async () => { root.unmount() }) }
})

test('clear-all stays available for zero recall results and removes notes outside the search', async () => {
    const root = mount()
    const url = '/api/desktop/agents/reviewer/memories'
    let stored = [note('outside', 'Vacation dates in July')]
    let clears = 0
    vi.stubGlobal('fetch', async (target: string, init: RequestInit) => {
        if (init.method === 'DELETE') {
            expect(target).toBe(url)
            clears++
            stored = []
            return new Response(null, { status: 204 })
        }
        return Response.json({ memories: target.endsWith('/recall') ? [] : stored })
    })
    try {
        await act(async () => { root.render(<DesktopCoworkerMemories agent={coworker('reviewer')} />) })
        await click('Memories')
        await enter('desktop-memory-search', 'unmatched')
        await act(async () => { dialog()!.querySelector<HTMLFormElement>('form[role="search"]')!.requestSubmit() })
        expect(dialog()?.textContent).toContain('No matches')
        const trash = document.querySelector<HTMLButtonElement>('[aria-label="Clear all memories"]')
        expect(trash).not.toBeNull()
        await act(async () => { trash!.click() })
        await click('Clear all')
        expect(clears).toBe(1)
        expect(stored).toEqual([])
        expect(dialog()?.textContent).toContain('No memories yet')
        expect(document.querySelector('[aria-label="Clear all memories"]')).toBeNull()
    } finally { await act(async () => { root.unmount() }) }
})

test('a failed clear keeps every note and the search intact, and retrying the confirmation succeeds', async () => {
    const root = mount()
    const url = '/api/desktop/agents/reviewer/memories'
    const outside = note('outside', 'Kept despite the failure')
    const apple = note('apples', 'Buys apples weekly')
    let stored = [outside, apple]
    let clears = 0
    const calls: string[] = []
    vi.stubGlobal('fetch', async (target: string, init: RequestInit) => {
        calls.push(`${init.method ?? 'GET'} ${target}`)
        if (init.method === 'DELETE' && target === url) {
            if (++clears === 1) return Response.json({ error: 'Engine unavailable' }, { status: 503 })
            stored = []
            return new Response(null, { status: 204 })
        }
        if (target === url + '/recall') {
            const { query } = JSON.parse(String(init.body))
            return Response.json({ memories: stored.filter(n => n.content.includes(query)) })
        }
        return Response.json({ memories: stored })
    })
    const trash = () => document.querySelector<HTMLButtonElement>('[aria-label="Clear all memories"]')
    try {
        await act(async () => { root.render(<DesktopCoworkerMemories agent={coworker('reviewer')} />) })
        await click('Memories')
        await enter('desktop-memory-search', 'apples')
        await act(async () => { dialog()!.querySelector<HTMLFormElement>('form[role="search"]')!.requestSubmit() })
        await act(async () => { trash()!.click() })
        await click('Clear all')
        expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe('Engine unavailable')
        expect(stored.map(n => n.id)).toEqual(['outside', 'apples'])
        expect(dialog()?.textContent).toContain('Buys apples weekly')
        expect(dialog()?.textContent).toContain('1 recalled for “apples”')
        expect((document.getElementById('desktop-memory-search') as HTMLInputElement).value).toBe('apples')
        expect(trash()).not.toBeNull()
        await act(async () => { trash()!.click() })
        await click('Clear all')
        expect(clears).toBe(2)
        expect(stored).toEqual([])
        expect(dialog()?.textContent).toContain('No memories yet')
        expect(dialog()?.querySelector('[role="alert"]')).toBeNull()
    } finally { await act(async () => { root.unmount() }) }
})

test('a partial clear failure refreshes the remaining notes and retains its error, search, and retry control', async () => {
    const root = mount()
    const url = '/api/desktop/agents/reviewer/memories'
    let stored = [note('outside', 'Vacation dates'), note('apples', 'Buys apples weekly')]
    let clears = 0
    vi.stubGlobal('fetch', async (target: string, init: RequestInit) => {
        if (init.method === 'DELETE') {
            stored = clears++ === 0 ? [stored[0]] : []
            return clears === 1 ? Response.json({ error: 'Could not finish clearing memories' }, { status: 503 }) : new Response(null, { status: 204 })
        }
        return Response.json({ memories: target.endsWith('/recall') ? stored.filter(n => n.content.includes('apples')) : stored })
    })
    const trash = () => document.querySelector<HTMLButtonElement>('[aria-label="Clear all memories"]')
    try {
        await act(async () => { root.render(<DesktopCoworkerMemories agent={coworker('reviewer')} />) })
        await click('Memories')
        await enter('desktop-memory-search', 'apples')
        await act(async () => { dialog()!.querySelector<HTMLFormElement>('form[role="search"]')!.requestSubmit() })
        await act(async () => { trash()!.click() })
        await click('Clear all')
        expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe('Could not finish clearing memories')
        expect(dialog()?.textContent).not.toContain('Buys apples weekly')
        expect(dialog()?.textContent).toContain('0 recalled for “apples”')
        expect((document.getElementById('desktop-memory-search') as HTMLInputElement).value).toBe('apples')
        expect(trash()).not.toBeNull()
        await act(async () => { trash()!.click() })
        await click('Clear all')
        expect(clears).toBe(2)
        expect(stored).toEqual([])
        expect(dialog()?.textContent).toContain('No memories yet')
        expect(dialog()?.querySelector('[role="alert"]')).toBeNull()
    } finally { await act(async () => { root.unmount() }) }
})

test('a clear finishing after a coworker switch cannot empty the newly selected coworker’s notes', async () => {
    const root = mount()
    const url = (id: string) => `/api/desktop/agents/${id}/memories`
    let finish!: (response: Response) => void
    const calls: string[] = []
    vi.stubGlobal('fetch', (target: string, init: RequestInit) => {
        calls.push(`${init.method ?? 'GET'} ${target}`)
        if (init.method === 'DELETE') {
            expect(target).toBe(url('first'))
            return new Promise<Response>(resolve => { finish = resolve })
        }
        return Promise.resolve(Response.json({ memories: target.includes('/second/') ? [note('kept', 'Second coworker note')] : [note('own', 'First coworker note')] }))
    })
    const show = (id: string) => act(async () => { root.render(<DesktopCoworkerMemories agent={coworker(id)} />) })
    try {
        await show('first')
        await click('Memories')
        expect(document.querySelector<HTMLButtonElement>('[aria-label="Clear all memories"]')).not.toBeNull()
        await act(async () => { document.querySelector<HTMLButtonElement>('[aria-label="Clear all memories"]')!.click() })
        await click('Clear all')
        await show('second')
        expect(dialog()?.textContent).toContain('Second coworker note')
        await act(async () => { finish(new Response(null, { status: 204 })) })
        expect(dialog()?.textContent).toContain('Second coworker note')
        expect(dialog()?.textContent).not.toContain('First coworker note')
        expect((document.getElementById('desktop-memory-search') as HTMLInputElement)?.value ?? '').toBe('')
        expect(calls).toEqual(['GET /api/desktop/agents/first/memories', 'DELETE /api/desktop/agents/first/memories', 'GET /api/desktop/agents/second/memories'])
    } finally { await act(async () => { root.unmount() }) }
})
