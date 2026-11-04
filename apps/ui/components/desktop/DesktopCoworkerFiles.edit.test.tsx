// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { hashText } from '@/lib/files/editable'
import type { FileCodeMirrorProps } from '@/components/files/FileCodeMirror'
import { DesktopConversation } from './DesktopConversation'

// Exercise the actual modal and conflict controls without CodeMirror's browser layout engine.
vi.mock('@/components/files/FileTextEditor', () => ({
    FileTextEditor: ({ value, onChange, fileName, readOnly, onSave }: FileCodeMirrorProps) => <textarea
        aria-label={`Edit ${fileName}`} value={value} readOnly={readOnly} onChange={event => onChange(event.target.value)}
        onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === 's') { event.preventDefault(); onSave?.() } }} />,
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const coworker = (id: string) => ({ id, name: id, description: '', createdAt: '', updatedAt: '' })
const entry = (name: string) => ({ name, type: 'file' as const, size: 1, modifiedAt: '2026-11-03T12:00:00Z' })
const button = (text: string) => [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === text || b.getAttribute('aria-label') === text)
const click = async (text: string) => { const b = button(text); expect(b, text).toBeDefined(); await act(async () => { b!.click() }) }
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
const type = async (text: string) => {
    const area = document.querySelector<HTMLTextAreaElement>('[data-testid="file-editor"] textarea')!
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => { setter.call(area, text); area.dispatchEvent(new Event('input', { bubbles: true })) })
}
const shown = () => document.querySelector('[data-testid="file-preview"]')?.textContent

/** A tiny disk per coworker; `onPut` can intercept saves to simulate a stale or failing write. */
function disk(files: Record<string, string>, onPut?: (agent: string, body: { content: string; baseHash: string | null }) => Response | undefined) {
    const puts: { agent: string; path: string; content: string; baseHash: string | null }[] = []
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://127.0.0.1')
        const agent = decodeURIComponent(url.pathname.split('/')[4])
        if (init?.method === 'PUT') {
            const body = JSON.parse(String(init.body))
            puts.push({ agent, ...body })
            const intercepted = onPut?.(agent, body)
            if (intercepted) return intercepted
            if (body.baseHash !== null && body.baseHash !== hashText(files[agent])) return Response.json({ error: 'changed', conflict: true, current: { content: files[agent], hash: hashText(files[agent]) } }, { status: 409 })
            files[agent] = body.content
            return Response.json({ path: body.path, hash: hashText(body.content), size: 1 })
        }
        if (url.pathname.endsWith('/files/read')) return Response.json({ path: 'brief.md', content: files[agent], size: 1, truncated: false, hash: hashText(files[agent]) })
        return Response.json({ path: '', entries: [entry('brief.md')] })
    })
    return { fetcher, puts }
}

async function openFile(root: ReturnType<typeof createRoot>, id: string) {
    await act(async () => { root.render(<DesktopConversation key={id} agent={coworker(id)} sessionId={null} sessions={[]} onSelectSession={() => {}} onChatSession={() => {}} />) })
    await click('Files')
    await flush()
    await click('brief.md')
    await flush()
}
const mount = () => { const c = document.createElement('div'); document.body.append(c); return createRoot(c) }
afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = '' })

test('edits and saves each coworker’s own same-named file', async () => {
    const files = { alice: 'Alice v1', bob: 'Bob v1' }
    const { fetcher, puts } = disk(files)
    vi.stubGlobal('fetch', fetcher)
    const root = mount()
    for (const id of ['alice', 'bob'] as const) {
        await openFile(root, id)
        await click('Edit')
        expect(button('Save changes')?.disabled).toBe(true)
        await type(`${id} v2`)
        await click('Save changes')
        await flush()
        expect(shown()).toBe(`${id} v2`)
        await click('Done')
    }
    expect(files).toEqual({ alice: 'alice v2', bob: 'bob v2' })
    expect(puts.map(p => [p.agent, p.baseHash])).toEqual([['alice', hashText('Alice v1')], ['bob', hashText('Bob v1')]])
    expect(fetcher).toHaveBeenCalledWith('/api/desktop/agents/alice/files/content', expect.objectContaining({ method: 'PUT' }))
    act(() => root.unmount())
})

test('cancel with edits asks first and never writes', async () => {
    const files = { alice: 'original' }
    const { fetcher, puts } = disk(files)
    vi.stubGlobal('fetch', fetcher)
    const root = mount()
    await openFile(root, 'alice')
    await click('Edit')
    await type('changed')
    await click('Cancel')
    await click('Keep editing')
    expect(document.querySelector<HTMLTextAreaElement>('[data-testid="file-editor"] textarea')!.value).toBe('changed')
    await click('Cancel')
    await click('Discard changes')
    expect(shown()).toBe('original')
    expect(puts).toEqual([])
    act(() => root.unmount())
})

test.each(['Close editor', 'Done', 'Close', 'Escape', 'Outside'])('%s cannot silently discard an edited file', async action => {
    const files = { alice: 'original' }
    const { fetcher, puts } = disk(files)
    vi.stubGlobal('fetch', fetcher)
    const root = mount()
    const dismiss = async () => {
        if (action === 'Escape') await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
        else if (action === 'Outside') await act(async () => { document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0 })) })
        else await click(action)
        await flush()
    }
    try {
        await openFile(root, 'alice')
        await click('Edit')
        await flush()
        await type('unsaved draft')
        await dismiss()
        expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('Discard your changes?')
        await click('Keep editing')
        expect(document.querySelector<HTMLTextAreaElement>('[data-testid="file-editor"] textarea')!.value).toBe('unsaved draft')
        await dismiss()
        await click('Discard changes')
        expect(document.querySelector('[data-testid="file-editor"]')).toBeNull()
        expect(files.alice).toBe('original')
        expect(puts).toEqual([])
    } finally { act(() => root.unmount()) }
})

test('a pending save blocks editor and Files dismissal until its result is shown', async () => {
    const files = { alice: 'original' }
    const ordinary = disk(files)
    let finish!: (response: Response) => void
    const saved = new Promise<Response>(resolve => { finish = resolve })
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => init?.method === 'PUT' ? saved : ordinary.fetcher(input, init)))
    const root = mount()
    try {
        await openFile(root, 'alice')
        await click('Edit')
        await type('draft in flight')
        await click('Save changes')
        await click('Done')
        await click('Close')
        expect(button('Close editor')?.disabled).toBe(true)
        expect(document.querySelector('[data-testid="file-editor"]')).not.toBeNull()
        await act(async () => { finish(Response.json({ error: 'Try again' }, { status: 500 })) })
        await flush()
        expect(document.querySelector<HTMLTextAreaElement>('[data-testid="file-editor"] textarea')!.value).toBe('draft in flight')
        expect(document.querySelector('[data-testid="edit-error"]')?.textContent).toContain('Try again')
    } finally { act(() => root.unmount()) }
})

test('a stale save keeps both the newer disk text and the draft, then reload or retry', async () => {
    const files = { alice: 'opened' }
    const { fetcher, puts } = disk(files)
    vi.stubGlobal('fetch', fetcher)
    const root = mount()
    await openFile(root, 'alice')
    await click('Edit')
    files.alice = 'coworker wrote this'
    await type('my draft')
    await click('Save changes')
    await flush()
    expect(document.querySelector('[data-testid="conflict-disk"]')?.textContent).toBe('coworker wrote this')
    expect(document.querySelector<HTMLTextAreaElement>('[data-testid="file-editor"] textarea')!.value).toBe('my draft')
    expect(files.alice).toBe('coworker wrote this')
    // Reload: editor takes the disk version, the draft stays visible to copy.
    await click('Keep theirs')
    expect(document.querySelector<HTMLTextAreaElement>('[data-testid="file-editor"] textarea')!.value).toBe('coworker wrote this')
    expect(document.querySelector<HTMLTextAreaElement>('[aria-label="Your previous edits"]')!.value).toBe('my draft')
    await type('merged')
    await click('Save changes')
    await flush()
    expect(files.alice).toBe('merged')
    expect(puts.at(-1)!.baseHash).toBe(hashText('coworker wrote this'))
    act(() => root.unmount())
})

test('save mine anyway retries against the version shown', async () => {
    const files = { alice: 'opened' }
    const { fetcher, puts } = disk(files)
    vi.stubGlobal('fetch', fetcher)
    const root = mount()
    await openFile(root, 'alice')
    await click('Edit')
    files.alice = 'newer'
    await type('mine')
    await click('Save changes')
    await flush()
    await click('Overwrite')
    await flush()
    expect(files.alice).toBe('mine')
    expect(puts.map(p => p.baseHash)).toEqual([hashText('opened'), hashText('newer')])
    expect(shown()).toBe('mine')
    act(() => root.unmount())
})

test('a failed write keeps the draft and the original, and retry saves', async () => {
    const files = { alice: 'original' }
    let fail = true
    const { fetcher } = disk(files, () => fail ? Response.json({ error: 'Desktop request failed' }, { status: 500 }) : undefined)
    vi.stubGlobal('fetch', fetcher)
    const root = mount()
    await openFile(root, 'alice')
    await click('Edit')
    await type('new text')
    await click('Save changes')
    await flush()
    expect(document.querySelector('[data-testid="edit-error"]')?.textContent).toContain('Your edits are still here')
    expect(document.querySelector<HTMLTextAreaElement>('[data-testid="file-editor"] textarea')!.value).toBe('new text')
    expect(files.alice).toBe('original')
    fail = false
    await click('Save changes')
    await flush()
    expect(files.alice).toBe('new text')
    act(() => root.unmount())
})

test('files without an edit hash cannot be edited', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).includes('/read')
        ? Response.json({ path: 'brief.md', content: 'big', size: 1, truncated: true })
        : Response.json({ path: '', entries: [entry('brief.md')] })))
    const root = mount()
    await openFile(root, 'alice')
    expect(button('Edit')?.disabled).toBe(true)
    act(() => root.unmount())
})

test('a late-writer conflict names both durable recovery copies in the original dialog', async () => {
    const files = { alice: 'opened' }
    const { fetcher } = disk(files, () => Response.json({
        error: 'changed', conflict: true,
        current: { content: 'external late edit', hash: hashText('external late edit') },
        recovery: { draft: 'docs/brief.draft-late.md', external: 'docs/brief.external-late.md' },
    }, { status: 409 }))
    vi.stubGlobal('fetch', fetcher)
    const root = mount()
    await openFile(root, 'alice')
    await click('Edit')
    await type('editor draft')
    await click('Save changes')
    await flush()
    expect(document.querySelector('[data-testid="conflict-disk"]')?.textContent).toBe('external late edit')
    expect(document.querySelector<HTMLTextAreaElement>('[data-testid="file-editor"] textarea')!.value).toBe('editor draft')
    const recovery = document.querySelector('[data-testid="edit-recovery"]')?.textContent
    expect(recovery).toContain('docs/brief.draft-late.md')
    expect(recovery).toContain('docs/brief.external-late.md')
    act(() => root.unmount())
})

test('reopening an interrupted save shows the recovered conflict in the original dialog', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).includes('/read')
        ? Response.json({ error: 'changed', conflict: true,
            current: { content: 'external after crash', hash: hashText('external after crash') },
            recovery: { draft: 'docs/brief.draft-crash.md', external: 'docs/brief.external-crash.md' } }, { status: 409 })
        : Response.json({ path: '', entries: [entry('brief.md')] })))
    const root = mount()
    await openFile(root, 'alice')
    expect(document.querySelector('[data-testid="file-editor"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="conflict-disk"]')?.textContent).toBe('external after crash')
    const recovery = document.querySelector('[data-testid="edit-recovery"]')?.textContent
    expect(recovery).toContain('docs/brief.draft-crash.md')
    expect(recovery).toContain('docs/brief.external-crash.md')
    act(() => root.unmount())
})
