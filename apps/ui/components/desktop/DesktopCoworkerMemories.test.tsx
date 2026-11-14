// @vitest-environment happy-dom
import { desktopBackgroundRead } from '@/test/desktop-background-fixture'
import { cancelDraftShutdown, flushDesktopDrafts } from '@/lib/desktop/draft-writes'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { DesktopCoworkerMemories } from './DesktopCoworkerMemories'
import { DesktopConversation } from './DesktopConversation'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const coworker = (id: string) => ({ id, name: id, description: '', createdAt: '', updatedAt: '' })
const note = (id: string, content: string) => ({ id, content, kind: 'fact', tags: ['project'], createdAt: '2026-11-03T08:00:00Z', strength: 0.64, status: 'dormant' })
const keywordIndex = { mode: 'keyword-only', backend: null, indexed: 0, pending: 0, omitted: 0, detail: 'Keyword search only. An embedding backend is not configured.' }
// Keep the existing CRUD scenarios focused on canonical note changes while supplying
// the semantic transport envelope. The integration case below checks the real endpoint.
function stubMemoryFetch(handler: (url: string, init: RequestInit) => Promise<Response> | Response) {
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
        const match = /^\/api\/desktop\/coworkers\/([^/]+)\/semantic-memory$/.exec(url)
        if (!match) return handler(url, init)
        if (init.method !== 'POST') return Response.json(keywordIndex)
        const response = await handler(`/api/desktop/agents/${match[1]}/memories/recall`, init)
        if (!response.ok) return response
        return Response.json({ ...(await response.json()), mode: 'keyword-only', detail: keywordIndex.detail, index: keywordIndex })
    })
}
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

test('semantic search uses the same editable MemoryRow and shows honest indexing status without requesting reinforcement', async () => {
    const root = mount(), requests: { url: string; body: unknown }[] = []
    const base = '/api/desktop/coworkers/reviewer/semantic-memory'
    const index = { mode: 'partial', backend: { backendId: 'fixture', model: 'fixture', version: '1', dimensions: 2 }, indexed: 1, pending: 1, omitted: 0, detail: 'Some notes are still indexing. Keyword matches are included.' }
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
        const body = init.body ? JSON.parse(String(init.body)) : null
        requests.push({ url, body })
        if (url === base + '/index') return Response.json(index)
        if (url === base) return Response.json(init.method === 'POST' ? { mode: 'partial', detail: index.detail, index, memories: [note('location', 'The printer is by the cabinet')] } : index)
        return Response.json({ memories: [note('location', 'The printer is by the cabinet')] })
    })
    try {
        await act(async () => { root.render(<DesktopCoworkerMemories agent={coworker('reviewer')} />) })
        await click('Memories')
        expect(dialog()?.textContent).toContain('Some notes are still indexing')
        await enter('memory-search', 'office equipment')
        await click('Search')
        expect(requests).toContainEqual({ url: base, body: { query: 'office equipment' } })
        expect(dialog()?.textContent).toContain('The printer is by the cabinet')
        expect(dialog()?.querySelector('[aria-label="Delete memory"]')).not.toBeNull()
        expect(dialog()?.textContent).toContain('64%')
        await click('Retry indexing')
        expect(requests).toContainEqual({ url: base + '/index', body: { operation: 'retry' } })
        expect(requests.every(value => !value.body || !('reinforce' in (value.body as object)))).toBe(true)
    } finally { await act(async () => { root.unmount() }) }
})

test('a coworker can open memories, retry and refresh without losing a chat draft', async () => {
    const root = mount()
    let finish!: (response: Response) => void
    const fetcher = vi.fn()
        .mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve }))
        .mockResolvedValueOnce(Response.json({ memories: [note('one', 'Keeps weekly notes.')] }))
        .mockResolvedValueOnce(Response.json({ memories: [] }))
    stubMemoryFetch((url: string, init: RequestInit) => url === '/api/desktop/agents/local-id/model'
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
    stubMemoryFetch((url: string, { signal }: RequestInit) => new Promise<Response>(finish => { reads.push({ url, signal: signal!, finish }) }))
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

function memoryField(name: string) {
    return document.querySelector<HTMLInputElement | HTMLTextAreaElement>('[name="' + name + '"]')
}

async function enter(name: string, value: string) {
    const field = memoryField(name)!
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
    stubMemoryFetch(async (target: string, init: RequestInit) => {
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
        await enter('memory-content', 'indigo test card')
        await enter('memory-search', '  indigo  ')
        await act(async () => { dialog()!.querySelector<HTMLFormElement>('form[role="search"]')!.requestSubmit() })
        expect(dialog()?.textContent).toContain('Could not search memories.')
        expect(dialog()?.textContent).not.toContain('No matches')
        await click('Retry')
        expect(dialog()?.textContent).toContain('No matches')
        expect(dialog()?.textContent).toContain('0 recalled for “indigo”')
        expect((memoryField('memory-content') as HTMLTextAreaElement).value).toBe('indigo test card')
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
    stubMemoryFetch((url: string, init: RequestInit) => url.endsWith('/recall')
        ? new Promise<Response>(finish => { reads.push({ signal: init.signal!, finish }) })
        : Promise.resolve(Response.json({ memories: [note('full', 'Full list note')] })))
    try {
        await act(async () => { root.render(<DesktopCoworkerMemories agent={coworker('reviewer')} />) })
        await click('Memories')
        await enter('memory-search', 'old')
        await click('Search')
        expect(dialog()?.textContent).toContain('Searching memories…')
        await enter('memory-search', 'current')
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
    stubMemoryFetch(async (url: string, init: RequestInit) => {
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
        await enter('memory-content', '  Project colors  ')
        await enter('memory-kind', '  preference ')
        await enter('memory-tags', ' blue, , navy ')
        await click('Save memory')
        expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe('Save failed. Try again.')
        expect((memoryField('memory-content') as HTMLTextAreaElement).value).toBe('  Project colors  ')
        await click('Save memory')
        expect(writes[1]).toEqual(writes[0])
        expect(writes[1]).toEqual({ content: 'Project colors', kind: 'preference', tags: ['blue', 'navy'], requestId: expect.stringMatching(/^[a-f\d-]{36}$/i) })
        expect(dialog()?.textContent).toContain('Project colors')
        expect(dialog()?.textContent).toContain('#navy')
        expect(memoryField('memory-content')).toBeNull()
        await click('Add memory')
        await enter('memory-content', 'Original draft')
        await click('Save memory')
        await enter('memory-content', 'Changed draft')
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
    stubMemoryFetch(async (url: string, init: RequestInit) => {
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
    stubMemoryFetch((url: string, init: RequestInit) => {
        calls.push(`${init.method ?? 'GET'} ${url}`)
        if (init.method === 'POST') return new Promise<Response>(resolve => { finish = resolve })
        return Promise.resolve(Response.json({ memories: url.includes('/second/') ? [note('kept', 'Second coworker note')] : [] }))
    })
    const show = (id: string) => act(async () => { root.render(<DesktopCoworkerMemories agent={coworker(id)} />) })
    try {
        await show('first')
        await click('Memories')
        await click('Add memory')
        await enter('memory-content', 'First coworker draft')
        await click('Save memory')
        await show('second')
        expect(dialog()?.textContent).toContain('Second coworker note')
        await click('Add memory')
        await enter('memory-content', 'Second coworker draft')
        await act(async () => { finish(Response.json({ id: 'saved' }, { status: 201 })) })
        expect((memoryField('memory-content') as HTMLTextAreaElement).value).toBe('Second coworker draft')
        expect(dialog()?.textContent).not.toContain('First coworker draft')
        expect(calls).toEqual(['GET /api/desktop/agents/first/memories', 'POST /api/desktop/agents/first/memories', 'GET /api/desktop/agents/second/memories'])
    } finally { await act(async () => { root.unmount() }) }
})

test('an already-deleted note is reconciled from the coworker list without discarding an open draft', async () => {
    const root = mount()
    const survivor = note('other', 'Existing second note')
    let stored = [note('gone', 'Already removed elsewhere'), survivor]
    let reads = 0
    stubMemoryFetch(async (url: string, init: RequestInit) => {
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
        await enter('memory-content', 'Draft in progress')
        await act(async () => { dialog()!.querySelector<HTMLButtonElement>('[aria-label="Delete memory"]')!.click() })
        await click('Delete')
        expect(reads).toBe(2)
        expect(dialog()?.textContent).not.toContain('Already removed elsewhere')
        expect(dialog()?.textContent).toContain('Existing second note')
        expect(dialog()?.querySelector('[role="alert"]')).toBeNull()
        expect((memoryField('memory-content') as HTMLTextAreaElement).value).toBe('Draft in progress')
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
    stubMemoryFetch(async (target: string, init: RequestInit) => {
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
        await enter('memory-search', 'apples')
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
        expect((memoryField('memory-search') as HTMLInputElement).value).toBe('apples')
        await act(async () => { trash()!.click() })
        await click('Clear all')
        expect(calls).toContain('DELETE /api/desktop/agents/reviewer/memories')
        expect(calls.filter(call => call.startsWith('DELETE'))).toHaveLength(1)
        expect(stored).toEqual([])
        expect(dialog()?.textContent).toContain('No memories yet')
        expect(dialog()?.textContent).not.toContain('recalled for')
        expect((memoryField('memory-search') as HTMLInputElement).value).toBe('')
        expect(document.querySelector('[aria-label="Clear all memories"]')).toBeNull()
    } finally { await act(async () => { root.unmount() }) }
})

test('clear-all stays available for zero recall results and removes notes outside the search', async () => {
    const root = mount()
    const url = '/api/desktop/agents/reviewer/memories'
    let stored = [note('outside', 'Vacation dates in July')]
    let clears = 0
    stubMemoryFetch(async (target: string, init: RequestInit) => {
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
        await enter('memory-search', 'unmatched')
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
    stubMemoryFetch(async (target: string, init: RequestInit) => {
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
        await enter('memory-search', 'apples')
        await act(async () => { dialog()!.querySelector<HTMLFormElement>('form[role="search"]')!.requestSubmit() })
        await act(async () => { trash()!.click() })
        await click('Clear all')
        expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe('Engine unavailable')
        expect(stored.map(n => n.id)).toEqual(['outside', 'apples'])
        expect(dialog()?.textContent).toContain('Buys apples weekly')
        expect(dialog()?.textContent).toContain('1 recalled for “apples”')
        expect((memoryField('memory-search') as HTMLInputElement).value).toBe('apples')
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
    stubMemoryFetch(async (target: string, init: RequestInit) => {
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
        await enter('memory-search', 'apples')
        await act(async () => { dialog()!.querySelector<HTMLFormElement>('form[role="search"]')!.requestSubmit() })
        await act(async () => { trash()!.click() })
        await click('Clear all')
        expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe('Could not finish clearing memories')
        expect(dialog()?.textContent).not.toContain('Buys apples weekly')
        expect(dialog()?.textContent).toContain('0 recalled for “apples”')
        expect((memoryField('memory-search') as HTMLInputElement).value).toBe('apples')
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
    stubMemoryFetch((target: string, init: RequestInit) => {
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
        expect((memoryField('memory-search') as HTMLInputElement)?.value ?? '').toBe('')
        expect(calls).toEqual(['GET /api/desktop/agents/first/memories', 'DELETE /api/desktop/agents/first/memories', 'GET /api/desktop/agents/second/memories'])
    } finally { await act(async () => { root.unmount() }) }
})

test('keeps the saved-list read alive while the first recall returns no matches', async () => {
    const root = mount()
    const saved = note('saved', 'Working hours for the office')
    let listSignal!: AbortSignal
    let complete!: (response: Response) => void
    let lists = 0
    stubMemoryFetch((url, init) => {
        if (url.endsWith('/recall')) return Response.json({ memories: [] })
        lists++
        listSignal = init.signal!
        return new Promise<Response>(resolve => { complete = resolve })
    })
    try {
        await act(async () => root.render(<DesktopCoworkerMemories agent={coworker('reviewer')} />))
        await click('Memories')
        await enter('memory-search', 'meeting')
        await click('Search')
        expect(dialog()?.textContent).toContain('No matches')
        expect(listSignal.aborted).toBe(false)
        await act(async () => complete(Response.json({ memories: [saved] })))
        expect(dialog()?.querySelector('[aria-label="Clear all memories"]')).not.toBeNull()
        expect(dialog()?.textContent).not.toContain(saved.content)
        await click('Clear search')
        expect(dialog()?.textContent).toContain(saved.content)
        expect(lists).toBe(1)
    } finally { await act(async () => root.unmount()) }
})

test('deleting the last note from recall removes Clear all when the saved list is empty', async () => {
    const root = mount()
    let notes = [note('last', 'Printer locations')]
    const url = '/api/desktop/agents/reviewer/memories'
    stubMemoryFetch((target, init) => {
        if (target === url + '/last' && init.method === 'DELETE') {
            notes = []
            return new Response(null, { status: 204 })
        }
        expect([url, url + '/recall']).toContain(target)
        return Response.json({ memories: notes })
    })
    try {
        await act(async () => root.render(<DesktopCoworkerMemories agent={coworker('reviewer')} />))
        await click('Memories')
        await enter('memory-search', 'Printer')
        await click('Search')
        expect(dialog()?.querySelector('[aria-label="Clear all memories"]')).not.toBeNull()
        await act(async () => { dialog()!.querySelector<HTMLButtonElement>('[aria-label="Delete memory"]')!.click() })
        await click('Delete')
        expect(dialog()?.textContent).toContain('No matches')
        expect(dialog()?.querySelector('[aria-label="Clear all memories"]')).toBeNull()
        await click('Clear search')
        expect(dialog()?.textContent).toContain('No memories yet')
    } finally { await act(async () => root.unmount()) }
})

test('a new recall does not report the previous query’s backend outcome while it is pending', async () => {
    const root = mount()
    const semantic = '/api/desktop/coworkers/reviewer/semantic-memory'
    let finish!: (response: Response) => void
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
        if (url !== semantic) return Response.json({ memories: [] })
        if (init.method !== 'POST') return Response.json(keywordIndex)
        const { query } = JSON.parse(String(init.body))
        if (query === 'earlier') return Response.json({ memories: [], mode: 'keyword-only', detail: 'Earlier lookup fell back to keywords.', index: keywordIndex })
        return new Promise<Response>(resolve => { finish = resolve })
    })
    try {
        await act(async () => root.render(<DesktopCoworkerMemories agent={coworker('reviewer')} />))
        await click('Memories')
        await enter('memory-search', 'earlier')
        await click('Search')
        expect(dialog()?.textContent).toContain('Earlier lookup fell back to keywords.')
        await enter('memory-search', 'current')
        await click('Search')
        expect(dialog()?.textContent).toContain('Searching memories…')
        expect(dialog()?.textContent).not.toContain('Earlier lookup fell back to keywords.')
        await act(async () => finish(Response.json({}, { status: 502 })))
        expect(dialog()?.textContent).toContain('Could not search memories.')
        expect(dialog()?.textContent).not.toContain('Earlier lookup fell back to keywords.')
    } finally { await act(async () => root.unmount()) }
})

test('quit waits for an admitted memory write and an Escape cannot close its dialog', async () => {
    const root = mount()
    const write = Promise.withResolvers<Response>()
    let rows: ReturnType<typeof note>[] = []
    let writes = 0
    stubMemoryFetch(async (_url, init) => {
        if (init.method !== 'POST') return Response.json({ memories: rows })
        writes++
        return write.promise
    })
    let drain: Promise<boolean> | undefined
    try {
        await act(async () => { root.render(<DesktopCoworkerMemories agent={coworker('reviewer')} />) })
        await click('Memories')
        await click('Add memory')
        await enter('memory-content', 'Memory being saved')
        await click('Save memory')
        expect(writes).toBe(1)
        const current = dialog()
        await act(async () => {
            current!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
        })
        expect(dialog()).toBe(current)
        expect((memoryField('memory-content') as HTMLTextAreaElement).value).toBe('Memory being saved')

        let settled = false
        await act(async () => {
            drain = flushDesktopDrafts()
            void drain.then(() => { settled = true })
        })
        expect(settled).toBe(false)
        rows = [note('saved', 'Memory being saved')]
        await act(async () => {
            write.resolve(Response.json({ id: 'saved' }, { status: 201 }))
            await drain
        })
        expect(settled).toBe(true)
        expect(dialog()?.textContent).toContain('Memory being saved')
        expect(memoryField('memory-content')).toBeNull()
    } finally {
        write.resolve(Response.json({ id: 'saved' }, { status: 201 }))
        await drain
        cancelDraftShutdown()
        await act(async () => { root.unmount() })
    }
})
