// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { DesktopAttachmentPicker } from './DesktopAttachmentPicker'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root, container: HTMLDivElement
const agent = { id: 'alice', name: 'Alice', description: '', createdAt: '', updatedAt: '' }
const entry = (name: string, size = 10) => ({ name, type: 'file', size })
const button = (label: string) => [...document.querySelectorAll('button')].find(node => node.textContent?.trim() === label || node.getAttribute('aria-label') === label)!
const click = (label: string) => act(async () => { expect(button(label), label).toBeDefined(); button(label).click() })
function deferred() { let resolve!: (value: Response) => void; return { promise: new Promise<Response>(done => { resolve = done }), resolve } }
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })
const render = (paths: string[], onChange = vi.fn(), disabled = false) => act(async () => root.render(<DesktopAttachmentPicker agent={agent} paths={paths} disabled={disabled} onChange={onChange} />))

test('reopening checks all selected parent folders before allowing another file or Done', async () => {
    const paths = ['a/one.md', 'a/two.md', 'b/three.md', 'b/.four.md']
    let first = deferred(), second = deferred()
    const folders: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'http://local'), folder = url.searchParams.get('path')!
        if (folder) { expect(url.searchParams.get('hidden')).toBe('1'); folders.push(folder); return folder === 'a' ? first.promise : second.promise }
        return Response.json({ entries: [entry('extra.md', 32768)] })
    }))
    const changed = vi.fn()
    await render(paths, changed); await click('Attach from Files')
    expect(button('Done').disabled).toBe(true)
    expect(button('extra.mdChecking selected files').disabled).toBe(true)
    await act(async () => { first.resolve(Response.json({ entries: [entry('one.md', 32768), entry('two.md', 32768)] })) })
    expect(button('Done').disabled).toBe(true)
    await act(async () => { second.resolve(Response.json({ entries: [entry('three.md', 32768), entry('.four.md', 32768)] })) })
    expect(button('Done').disabled).toBe(false)
    expect(button('extra.mdOver 128 KiB total').disabled).toBe(true)
    await click('Cancel')
    expect(changed).not.toHaveBeenCalled()
    first = deferred(); second = deferred()
    await click('Attach from Files')
    expect(button('Done').disabled).toBe(true)
    expect(folders).toEqual(['a', 'b', 'a', 'b'])
    await click('Cancel')
    await act(async () => { first.resolve(Response.json({ entries: [] })); second.resolve(Response.json({ entries: [] })) })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
})

test('missing and oversized retained files can be removed, including the last attachment', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'http://local')
        return Response.json({ entries: url.searchParams.get('path') === 'docs' ? [entry('large.md', 32769)] : [] })
    }))
    const changed = vi.fn()
    await render(['docs/missing.md', 'docs/large.md'], changed); await click('Attach from Files')
    expect(button('Done').disabled).toBe(true)
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Remove missing')
    expect(button('Remove attachment missing.md').disabled).toBe(false)
    await click('Remove attachment missing.md'); await click('Remove attachment large.md')
    expect(button('Done').disabled).toBe(false)
    await click('Done')
    expect(changed).toHaveBeenCalledExactlyOnceWith([])
})

test('an unknown selected folder remains blocked until retry succeeds and an old open cannot overwrite it', async () => {
    const old = deferred()
    let count = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'http://local')
        if (!url.searchParams.get('path')) return Response.json({ entries: [] })
        count++
        if (count === 1) return old.promise
        if (count === 2) return Response.json({ error: 'Offline' }, { status: 502 })
        return Response.json({ entries: [entry('saved.md')] })
    }))
    const changed = vi.fn()
    await render(['docs/saved.md'], changed); await click('Attach from Files'); await click('Cancel'); await click('Attach from Files')
    expect(button('Done').disabled).toBe(true)
    expect(document.body.textContent).toContain('Could not check all selected files.')
    await click('Retry selected files')
    expect(button('Done').disabled).toBe(false)
    await act(async () => { old.resolve(Response.json({ entries: [] })) })
    expect(button('Done').disabled).toBe(false)
    await click('Done')
    expect(changed).toHaveBeenCalledExactlyOnceWith(['docs/saved.md'])
})

test('becoming disabled while open prevents a staged selection from being applied', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ entries: [entry('saved.md')] })))
    const changed = vi.fn()
    await render(['saved.md'], changed); await click('Attach from Files')
    await render(['saved.md'], changed, true)
    expect(button('Done').disabled).toBe(true)
    expect(button('Remove attachment saved.md').disabled).toBe(true)
    await click('Done'); expect(changed).not.toHaveBeenCalled()
})
