// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { FileCodeMirrorProps } from '@/components/files/FileCodeMirror'
import { hashText } from '@/lib/files/editable'
import { DesktopCoworkerFiles } from './DesktopCoworkerFiles'

// Keep the actual Files, context menu, dialogs, and save flow; only omit browser editor layout.
vi.mock('@/components/files/FileTextEditor', () => ({
    FileTextEditor: ({ value, onChange, fileName, readOnly }: FileCodeMirrorProps) => <textarea
        aria-label={`Edit ${fileName}`} value={value} readOnly={readOnly} onChange={event => onChange(event.target.value)} />,
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const coworker = (id: string) => ({ id, name: id, description: '', createdAt: '', updatedAt: '' })
const button = (name: string) => [...document.querySelectorAll('button')].find(node => node.textContent?.trim() === name || node.getAttribute('aria-label') === name)
const click = async (name: string) => {
    const node = button(name)
    expect(node, name).toBeDefined()
    await act(async () => { node!.click() })
}
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
const change = (field: HTMLInputElement | HTMLTextAreaElement, value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
    field.dispatchEvent(new Event('change', { bubbles: true }))
})
const key = (field: HTMLElement, value: string) => act(async () => {
    field.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }))
})

async function rename(name: string) {
    const row = button(name)
    expect(row, name).toBeDefined()
    await act(async () => { row!.dispatchEvent(new MouseEvent('contextmenu', { button: 2, bubbles: true, cancelable: true })) })
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent?.trim() === 'Rename')
    expect(item).toBeDefined()
    await act(async () => { item!.click() })
    // Radix releases the menu's focus scope on the next task before opening the name field.
    await flush()
    const field = document.querySelector<HTMLInputElement>('input[aria-label="New name"]')
    expect(field).not.toBeNull()
    expect(document.activeElement).toBe(field)
    return field!
}

type RenameRequest = { agent: string; path: string; name: string }
function disk(files: Record<string, Record<string, string>>, intercept?: (request: RenameRequest) => Response | Promise<Response> | undefined) {
    const renames: RenameRequest[] = []
    const reads: { agent: string; path: string }[] = []
    const puts: { agent: string; path: string; content: string; baseHash: string }[] = []
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://127.0.0.1')
        const agent = decodeURIComponent(url.pathname.split('/')[4])
        const owned = files[agent]
        if (!owned) return Response.json({ error: 'Unknown coworker' }, { status: 404 })
        if (url.pathname.endsWith('/rename') && init?.method === 'POST') {
            const body = JSON.parse(String(init.body)) as { path: string; name: string }
            const request = { agent, ...body }
            renames.push(request)
            const response = await intercept?.(request)
            if (response) return response
            const parent = body.path.includes('/') ? body.path.slice(0, body.path.lastIndexOf('/') + 1) : ''
            const target = `${parent}${body.name}`
            if (Object.keys(owned).some(path => path === target || path.startsWith(`${target}/`))) return Response.json({ error: 'That name is already taken. The existing file was kept.' }, { status: 409 })
            const moved = Object.entries(owned).filter(([path]) => path === body.path || path.startsWith(`${body.path}/`))
            if (!moved.length) return Response.json({ error: 'That file is no longer here.' }, { status: 404 })
            for (const [path, content] of moved) { delete owned[path]; owned[`${target}${path.slice(body.path.length)}`] = content }
            return Response.json({ path: target, name: body.name })
        }
        if (url.pathname.endsWith('/content') && init?.method === 'PUT') {
            const body = JSON.parse(String(init.body)) as { path: string; content: string; baseHash: string }
            puts.push({ agent, ...body })
            if (owned[body.path] === undefined || hashText(owned[body.path]) !== body.baseHash) return Response.json({ error: 'Changed file' }, { status: 409 })
            owned[body.path] = body.content
            return Response.json({ path: body.path, hash: hashText(body.content) })
        }
        const path = url.searchParams.get('path') ?? ''
        if (url.pathname.endsWith('/read')) {
            reads.push({ agent, path })
            const content = owned[path]
            return content === undefined ? Response.json({ error: 'Not found' }, { status: 404 })
                : Response.json({ path, content, hash: hashText(content), truncated: false })
        }
        const prefix = path ? `${path}/` : ''
        const entries = new Map<string, { name: string; type: 'dir' | 'file'; size: number; modifiedAt: string }>()
        for (const candidate of Object.keys(owned)) {
            if (!candidate.startsWith(prefix)) continue
            const relative = candidate.slice(prefix.length)
            const name = relative.split('/')[0]
            if (!name || (name.startsWith('.') && !url.searchParams.has('hidden'))) continue
            entries.set(name, { name, type: relative.includes('/') ? 'dir' : 'file', size: 1, modifiedAt: '2026-11-03T12:00:00Z' })
        }
        return Response.json({ path, entries: [...entries.values()] })
    })
    return { fetcher, renames, reads, puts }
}

const roots: ReturnType<typeof createRoot>[] = []
async function mount(id = 'alice') {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => { root.render(<DesktopCoworkerFiles key={id} agent={coworker(id)} />) })
    await click('Files')
    await flush()
    return root
}
afterEach(() => {
    act(() => { for (const root of roots.splice(0)) root.unmount() })
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
})

test('Rename selects the stem and Enter followed by blur posts the nested path only once', async () => {
    const files = { alice: { 'docs/brief.md': 'original' } }
    const fixture = disk(files)
    vi.stubGlobal('fetch', fixture.fetcher)
    await mount()
    await click('docs')
    await flush()
    const field = await rename('brief.md')
    expect(field.value).toBe('brief.md')
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, 5])
    await change(field, '  plan.md  ')
    await act(async () => {
        field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
        field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    await flush()
    expect(fixture.renames).toEqual([{ agent: 'alice', path: 'docs/brief.md', name: 'plan.md' }])
    expect(button('brief.md')).toBeUndefined()
    expect(button('plan.md')?.getAttribute('aria-selected')).toBe('true')
    expect(document.querySelector('nav[aria-label="Folder"]')?.textContent).toContain('docs')
    expect(files.alice).toEqual({ 'docs/plan.md': 'original' })
})

test('blur commits to the selected coworker and reopening previews its new name', async () => {
    const files = { alice: { 'brief.md': 'Alice notes' }, bob: { 'brief.md': 'Bob notes' } }
    const fixture = disk(files)
    vi.stubGlobal('fetch', fixture.fetcher)
    const root = await mount()
    const field = await rename('brief.md')
    await change(field, 'alice.md')
    await act(async () => { field.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
    await flush()
    await click('Done')
    await click('Files')
    await flush()
    await click('alice.md')
    await flush()
    expect(document.querySelector('[data-testid="file-preview"]')?.textContent).toBe('Alice notes')
    expect(fixture.reads.at(-1)).toEqual({ agent: 'alice', path: 'alice.md' })
    await click('Done')
    await act(async () => { root.render(<DesktopCoworkerFiles key="bob" agent={coworker('bob')} />) })
    await click('Files')
    await flush()
    await click('brief.md')
    await flush()
    expect(document.querySelector('[data-testid="file-preview"]')?.textContent).toBe('Bob notes')
    expect(fixture.renames).toEqual([{ agent: 'alice', path: 'brief.md', name: 'alice.md' }])
    expect(files.bob).toEqual({ 'brief.md': 'Bob notes' })
})

test('Escape, an unchanged name, and an empty name keep the file without a request', async () => {
    const fixture = disk({ alice: { 'brief.md': 'original' } })
    vi.stubGlobal('fetch', fixture.fetcher)
    await mount()
    let field = await rename('brief.md')
    await change(field, 'discard.md')
    await key(field, 'Escape')
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(document.querySelector('input[aria-label="New name"]')).toBeNull()
    field = await rename('brief.md')
    await change(field, ' brief.md ')
    await key(field, 'Enter')
    field = await rename('brief.md')
    await change(field, '   ')
    await act(async () => { field.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
    expect(fixture.renames).toEqual([])
    expect(button('brief.md')).toBeDefined()
    expect(document.querySelector('input[aria-label="New name"]')).toBeNull()
    await key(document.body, 'Escape')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
})

test('a name conflict keeps both files and allows a fresh rename attempt', async () => {
    const files = { alice: { 'brief.md': 'source', 'taken.md': 'existing' } }
    const fixture = disk(files)
    vi.stubGlobal('fetch', fixture.fetcher)
    await mount()
    let field = await rename('brief.md')
    await change(field, 'taken.md')
    await key(field, 'Enter')
    await flush()
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('That name is already taken. The existing file was kept.')
    expect(files.alice).toEqual({ 'brief.md': 'source', 'taken.md': 'existing' })
    expect(button('brief.md')?.disabled).toBe(false)
    field = await rename('brief.md')
    await change(field, 'available.md')
    await key(field, 'Enter')
    await flush()
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(files.alice).toEqual({ 'available.md': 'source', 'taken.md': 'existing' })
    expect(fixture.renames.map(request => request.name)).toEqual(['taken.md', 'available.md'])
})

test('an in-flight rename blocks folder actions and every Files dismissal until the error is shown', async () => {
    let finish!: (response: Response) => void
    const pending = new Promise<Response>(resolve => { finish = resolve })
    const fixture = disk({ alice: { 'docs/brief.md': 'original', 'docs/child/note.md': 'child' } }, () => pending)
    vi.stubGlobal('fetch', fixture.fetcher)
    await mount()
    await click('docs')
    await flush()
    const field = await rename('brief.md')
    await change(field, 'plan.md')
    await key(field, 'Enter')
    expect(document.querySelector('[role="status"]')?.textContent).toBe('Renaming…')
    for (const name of ['Workspace home', 'docs', '..', 'child', 'brief.md', 'Show hidden files', 'Import', 'Refresh files']) expect(button(name)?.disabled, name).toBe(true)
    for (const dismiss of ['Done', 'Close', 'Escape', 'Outside']) {
        if (dismiss === 'Escape') await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
        else if (dismiss === 'Outside') await act(async () => { document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0 })) })
        else await click(dismiss)
        await flush()
        expect(document.querySelector('[role="dialog"]'), dismiss).not.toBeNull()
    }
    expect(fixture.renames).toHaveLength(1)
    await act(async () => { finish(Response.json({ error: 'Rename could not finish. Try again.' }, { status: 503 })) })
    await flush()
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Rename could not finish. Try again.')
    expect(button('brief.md')?.disabled).toBe(false)
    await click('Done')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
})

test('renaming a folder opens and edits its descendant through the new path only', async () => {
    const files = { alice: { 'docs/brief.md': 'original' } }
    const fixture = disk(files)
    vi.stubGlobal('fetch', fixture.fetcher)
    await mount()
    const field = await rename('docs')
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, 4])
    await change(field, 'plans')
    await key(field, 'Enter')
    await flush()
    expect(button('docs')).toBeUndefined()
    await click('plans')
    await flush()
    await click('brief.md')
    await flush()
    expect(document.querySelector('[data-testid="file-preview"]')?.textContent).toBe('original')
    await click('Edit')
    const editor = document.querySelector<HTMLTextAreaElement>('[data-testid="file-editor"] textarea')!
    await change(editor, 'updated after rename')
    await click('Save changes')
    await flush()
    expect(fixture.renames).toEqual([{ agent: 'alice', path: 'docs', name: 'plans' }])
    expect(fixture.reads).toEqual([{ agent: 'alice', path: 'plans/brief.md' }])
    expect(fixture.puts).toEqual([{ agent: 'alice', path: 'plans/brief.md', content: 'updated after rename', baseHash: hashText('original') }])
    expect(files.alice).toEqual({ 'plans/brief.md': 'updated after rename' })
    expect(document.querySelector('[data-testid="file-preview"]')?.textContent).toBe('updated after rename')
})
