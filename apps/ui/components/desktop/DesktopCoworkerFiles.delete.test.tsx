// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { FileCodeMirrorProps } from '@/components/files/FileCodeMirror'
import { hashText } from '@/lib/files/editable'
import { DesktopCoworkerFiles } from './DesktopCoworkerFiles'

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
const alertDialog = () => document.querySelector('[role="alertdialog"]')
const clickAlert = async (name: string) => {
    const node = [...(alertDialog()?.querySelectorAll('button') ?? [])].find(item => item.textContent?.trim() === name)
    expect(node, name).toBeDefined()
    await act(async () => { node!.click() })
}

async function chooseDelete(name: string) {
    const row = button(name)
    expect(row, name).toBeDefined()
    await act(async () => { row!.dispatchEvent(new MouseEvent('contextmenu', { button: 2, bubbles: true, cancelable: true })) })
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent?.trim() === 'Delete')
    expect(item).toBeDefined()
    await act(async () => { item!.click() })
    await flush()
    expect(alertDialog()?.textContent).toContain(`Delete ${name}?`)
}

type DeleteRequest = { path: string; identity?: string }
function disk(files: Record<string, string>, fail?: string) {
    const deletes: DeleteRequest[] = []
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://127.0.0.1')
        if (url.pathname.endsWith('/delete') && init?.method === 'POST') {
            const body = JSON.parse(String(init.body)) as DeleteRequest
            deletes.push(body)
            if (fail) return Response.json({ error: fail }, { status: 409 })
            const removed = Object.keys(files).filter(path => path === body.path || path.startsWith(`${body.path}/`))
            if (!removed.length) return Response.json({ error: 'That file is no longer here.' }, { status: 404 })
            for (const path of removed) delete files[path]
            return Response.json({ path: body.path })
        }
        const path = url.searchParams.get('path') ?? ''
        if (url.pathname.endsWith('/image') && files[path] !== undefined) {
            const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1])
            return new Response(png, { headers: { 'content-type': 'image/png' } })
        }
        if (url.pathname.endsWith('/read')) {
            const content = files[path]
            return content === undefined ? Response.json({ error: 'Not found' }, { status: 404 })
                : Response.json({ path, content, hash: hashText(content), identity: `4:${path.split('/').at(-1)!.length}`, truncated: false })
        }
        const prefix = path ? `${path}/` : ''
        const entries = new Map<string, { name: string; type: 'dir' | 'file'; size: number; modifiedAt: string; identity: string }>()
        for (const candidate of Object.keys(files)) {
            if (!candidate.startsWith(prefix)) continue
            const relative = candidate.slice(prefix.length)
            const name = relative.split('/')[0]
            if (!name) continue
            entries.set(name, { name, type: relative.includes('/') ? 'dir' : 'file', size: 1, modifiedAt: '2026-11-04T00:00:00.000Z', identity: `4:${name.length}` })
        }
        return Response.json({ path, entries: [...entries.values()] })
    })
    return { fetcher, deletes, files }
}

const roots: ReturnType<typeof createRoot>[] = []
async function mount() {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => { root.render(<DesktopCoworkerFiles agent={coworker('alice')} />) })
    await click('Files')
    await flush()
}
afterEach(() => {
    act(() => { for (const root of roots.splice(0)) root.unmount() })
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
})

test('Cancel names the file and sends nothing', async () => {
    const fixture = disk({ 'docs/notes.md': 'Alice', 'docs/other.md': 'Sibling' })
    vi.stubGlobal('fetch', fixture.fetcher)
    await mount()
    await click('docs')
    await flush()
    await chooseDelete('notes.md')
    expect(alertDialog()?.textContent).toContain('The file is deleted from the box. This cannot be undone.')
    await clickAlert('Cancel')
    expect(alertDialog()).toBeNull()
    expect(fixture.deletes).toEqual([])
    expect(button('notes.md')).toBeDefined()
    expect(fixture.files).toEqual({ 'docs/notes.md': 'Alice', 'docs/other.md': 'Sibling' })
})

test('a folder confirmation uses the folder sentence and Cancel leaves it', async () => {
    const fixture = disk({ 'docs/notes.md': 'Alice', 'keep.txt': 'Keep' })
    vi.stubGlobal('fetch', fixture.fetcher)
    await mount()
    await chooseDelete('docs')
    expect(alertDialog()?.textContent).toContain('The folder and everything inside it are deleted from the box. This cannot be undone.')
    await clickAlert('Cancel')
    expect(fixture.deletes).toEqual([])
    expect(button('docs')).toBeDefined()
})

test('confirming Delete removes only that path and does not select the sibling', async () => {
    const fixture = disk({ 'notes.md': 'Alice', 'other.md': 'Sibling' })
    vi.stubGlobal('fetch', fixture.fetcher)
    await mount()
    await chooseDelete('notes.md')
    await clickAlert('Delete')
    await flush()
    expect(fixture.deletes).toEqual([{ path: 'notes.md', identity: '4:8' }])
    expect(button('notes.md')).toBeUndefined()
    expect(button('other.md')?.getAttribute('aria-selected')).not.toBe('true')
    expect(fixture.files).toEqual({ 'other.md': 'Sibling' })
    expect(document.body.textContent).not.toContain('other.md is deleted')
})

test('a refused delete leaves both rows and shows the server message', async () => {
    const fixture = disk({ 'notes.md': 'Alice', 'other.md': 'Sibling' }, '“notes.md” was renamed or replaced. It was left unchanged.')
    vi.stubGlobal('fetch', fixture.fetcher)
    await mount()
    await chooseDelete('notes.md')
    await clickAlert('Delete')
    await flush()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('left unchanged')
    expect(button('notes.md')).toBeDefined()
    expect(button('other.md')?.getAttribute('aria-selected')).not.toBe('true')
    expect(fixture.files['notes.md']).toBe('Alice')
})

test('the open editor does not offer Delete', async () => {
    const fixture = disk({ 'notes.md': 'Alice' })
    vi.stubGlobal('fetch', fixture.fetcher)
    await mount()
    await click('notes.md')
    await flush()
    await click('Edit')
    expect(button('Delete file')).toBeUndefined()
    expect(document.querySelector('[role="menuitem"]')).toBeNull()
    expect(alertDialog()).toBeNull()
    expect(fixture.deletes).toEqual([])
})

test('deletes the confirmed preview and returns to its folder without opening a sibling', async () => {
    const fixture = disk({ 'docs/notes.md': 'Alice', 'docs/other.md': 'Sibling' })
    vi.stubGlobal('fetch', fixture.fetcher)
    await mount()
    await click('docs')
    await flush()
    await click('notes.md')
    await flush()
    await click('Delete file')
    expect(alertDialog()?.textContent).toContain('Delete notes.md?')
    await clickAlert('Cancel')
    expect(fixture.deletes).toEqual([])
    expect(document.querySelector('[data-testid="file-preview"]')?.textContent).toBe('Alice')
    await click('Delete file')
    await clickAlert('Delete')
    await flush()
    expect(fixture.deletes).toEqual([{ path: 'docs/notes.md', identity: '4:8' }])
    expect(document.querySelector('[data-testid="file-preview"]')).toBeNull()
    expect(button('other.md')?.getAttribute('aria-selected')).toBe('false')
    expect(fixture.files).toEqual({ 'docs/other.md': 'Sibling' })
})

test('keeps the preview open and shows the reason when its delete is refused', async () => {
    const fixture = disk({ 'notes.md': 'Alice' }, '“notes.md” was renamed or replaced. It was left unchanged.')
    vi.stubGlobal('fetch', fixture.fetcher)
    await mount()
    await click('notes.md')
    await flush()
    await click('Delete file')
    await clickAlert('Delete')
    await flush()
    expect(fixture.deletes).toEqual([{ path: 'notes.md', identity: '4:8' }])
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('left unchanged')
    expect(document.querySelector('[data-testid="file-preview"]')?.textContent).toBe('Alice')
    expect(fixture.files['notes.md']).toBe('Alice')
})

test('the image preview deletes the same file identity it requested', async () => {
    const fixture = disk({ 'photo.png': 'Image', 'notes.md': 'Keep' })
    vi.stubGlobal('fetch', fixture.fetcher)
    await mount()
    await click('photo.png')
    await flush()
    expect(document.querySelector('[data-testid="file-image-preview"]')).not.toBeNull()
    expect(fixture.fetcher.mock.calls.some(([url]) => String(url).includes('/image?path=photo.png&identity=4%3A9'))).toBe(true)
    await click('Delete file')
    await clickAlert('Delete')
    await flush()
    expect(fixture.deletes).toEqual([{ path: 'photo.png', identity: '4:9' }])
    expect(document.querySelector('[data-testid="file-image-preview"]')).toBeNull()
    expect(fixture.files).toEqual({ 'notes.md': 'Keep' })
})

test('a file read from a newer identity than the listing offers no preview delete', async () => {
    const fixture = disk({ 'notes.md': 'Alice' })
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await fixture.fetcher(input, init)
        if (!String(input).includes('/read?')) return response
        return Response.json({ ...await response.json(), identity: '10:8' })
    })
    await mount()
    await click('notes.md')
    await flush()
    expect(document.querySelector('[data-testid="file-preview"]')?.textContent).toBe('Alice')
    expect(button('Delete file')).toBeUndefined()
    expect(fixture.deletes).toEqual([])
})
