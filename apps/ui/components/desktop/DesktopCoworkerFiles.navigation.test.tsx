// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { FileCodeMirrorProps } from '@/components/files/FileCodeMirror'
import { DesktopCoworkerFiles } from './DesktopCoworkerFiles'

vi.mock('@/components/files/FileTextEditor', () => ({
    FileTextEditor: ({ value, onChange, fileName, readOnly }: FileCodeMirrorProps) => <textarea
        aria-label={`Edit ${fileName}`} value={value} readOnly={readOnly} onChange={event => onChange(event.target.value)} />,
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const alice = { id: 'alice', name: 'Alice', description: '', createdAt: '', updatedAt: '' }
const button = (name: string) => [...document.querySelectorAll('button')].find(node => node.textContent?.trim() === name || node.getAttribute('aria-label') === name)
const click = async (name: string) => {
    const node = button(name)
    expect(node, name).toBeDefined()
    await act(async () => { node!.click() })
}
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1])
const mp3 = Uint8Array.from([0xff, 0xfb, 0x90, 0xc0, 0, 0, 0, 0])
const text: Record<string, string> = {
    'docs/alpha.md': 'alpha body',
    'docs/zeta.txt': 'zeta body',
    'docs/.secret.txt': 'secret body',
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.innerHTML = '' })

function entry(name: string, type: 'file' | 'dir', identity?: string) {
    return { name, type, size: 4, modifiedAt: '2026-11-04T00:00:00.000Z', ...(identity && { identity }) }
}

function listed(hidden: boolean) {
    return [
        entry('zeta.txt', 'file', '9:1'),
        entry('beta', 'dir'),
        entry('alpha.md', 'file', '1:1'),
        entry('mid.mp3', 'file', '2:1'),
        entry('photo.png', 'file', '4:1'),
        ...(hidden ? [entry('.secret.txt', 'file', '3:1')] : []),
    ]
}

function installFetch() {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'http://127.0.0.1')
        const path = url.searchParams.get('path') ?? ''
        if (url.pathname.includes('/agents/bob/')) return Response.json({ path: '', entries: [entry('other.txt', 'file', '5:1')] })
        if (url.pathname.endsWith('/files/image')) return new Response(png, { headers: { 'content-type': 'image/png' } })
        if (url.pathname.endsWith('/files/audio')) return new Response(mp3, { headers: { 'content-type': 'audio/mpeg' } })
        if (url.pathname.endsWith('/files/read')) {
            const content = text[path]
            if (content) return Response.json({ path, content, size: content.length, truncated: false, hash: 'abc', identity: '1:1' })
            return Response.json({ error: 'Could not preview this file.' }, { status: 404 })
        }
        if (path === 'docs') return Response.json({ path: 'docs', entries: listed(url.searchParams.get('hidden') === '1') })
        return Response.json({ path: '', entries: [entry('docs', 'dir')] })
    }))
}

async function openDocs() {
    installFetch()
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => { root.render(<DesktopCoworkerFiles agent={alice} />) })
    await click('Files')
    await flush()
    await click('docs')
    await flush()
    return root
}

async function key(name: string, init: KeyboardEventInit = {}, target: EventTarget = window) {
    const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init })
    await act(async () => { target.dispatchEvent(event) })
    await flush()
    return event
}

test('previous and next follow alphabetical files, skip folders, and wrap', async () => {
    const root = await openDocs()
    await click('zeta.txt')
    await flush()

    expect(button('Previous file')).toBeDefined()
    expect(button('Next file')).toBeDefined()
    expect(document.body.textContent).toContain('4 / 4')
    expect(document.body.textContent).not.toContain('beta')

    await click('Previous file')
    await flush()
    expect(document.querySelector('[data-testid="file-image-preview"]')?.getAttribute('alt')).toBe('photo.png')
    expect(document.body.textContent).toContain('3 / 4')
    expect(document.body.textContent).not.toContain('zeta body')

    await click('Previous file')
    await flush()
    expect(document.querySelector('[data-testid="file-audio-preview"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="file-image-preview"]')).toBeNull()
    expect(document.body.textContent).toContain('2 / 4')

    await click('Next file')
    await flush()
    expect(document.querySelector('[data-testid="file-image-preview"]')?.getAttribute('alt')).toBe('photo.png')
    await click('Next file')
    await flush()
    expect(document.querySelector('[data-testid="file-preview"]')?.textContent).toBe('zeta body')
    await click('Next file')
    await flush()
    expect(document.querySelector('[data-testid="file-preview"]')?.textContent).toBe('alpha body')
    expect(document.body.textContent).toContain('1 / 4')
    expect(document.body.textContent).not.toContain('zeta body')
    act(() => root.unmount())
})

test('hidden files join the order only while that listing shows them', async () => {
    const root = await openDocs()
    await click('alpha.md')
    await flush()
    expect(document.body.textContent).toContain('1 / 4')
    expect(document.body.textContent).not.toContain('.secret.txt')

    await click('Back to folder')
    await flush()
    await click('Show hidden files')
    await flush()
    await click('alpha.md')
    await flush()
    expect(document.body.textContent).toContain('2 / 5')
    await click('Previous file')
    await flush()
    expect(document.querySelector('[data-testid="file-preview"]')?.textContent).toBe('secret body')
    expect(document.body.textContent).not.toContain('alpha body')
    act(() => root.unmount())
})

test('returns focus to the current file and then to its containing folder', async () => {
    const root = await openDocs()
    try {
        expect(document.activeElement).toBe(button('..'))
        button('alpha.md')!.focus()
        await click('alpha.md')
        expect(document.activeElement).toBe(button('Back to folder'))
        await click('Previous file')
        expect(document.querySelector('[data-testid="file-preview"]')?.textContent).toBe('zeta body')
        await click('Back to folder')
        expect(document.activeElement).toBe(button('zeta.txt'))
        await click('..')
        expect(document.activeElement).toBe(button('docs'))
    } finally {
        act(() => root.unmount())
    }
})

test('one file in the folder has no arrows', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'http://127.0.0.1')
        if (url.pathname.endsWith('/files/read')) return Response.json({ path: 'only.md', content: 'only body', size: 9, truncated: false, hash: 'abc' })
        return Response.json({ path: '', entries: [entry('only.md', 'file', '1:1')] })
    }))
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => { root.render(<DesktopCoworkerFiles agent={alice} />) })
    await click('Files')
    await flush()
    await click('only.md')
    await flush()
    expect(document.querySelector('[data-testid="file-preview"]')?.textContent).toBe('only body')
    expect(button('Previous file')).toBeUndefined()
    expect(button('Next file')).toBeUndefined()
    await key('ArrowRight')
    expect(document.querySelector('[data-testid="file-preview"]')?.textContent).toBe('only body')
    act(() => root.unmount())
})

test('loading and failed previews keep the arrows and drop a replaced read', async () => {
    let release: ((response: Response) => void) | undefined
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'http://127.0.0.1')
        const path = url.searchParams.get('path') ?? ''
        if (url.pathname.endsWith('/files/read') && path === 'docs/alpha.md') return new Promise<Response>(resolve => { release = resolve })
        if (url.pathname.endsWith('/files/read') && path === 'docs/zeta.txt') return Response.json({ error: 'Could not preview this file.' }, { status: 404 })
        if (url.pathname.endsWith('/files/audio')) return new Response(mp3, { headers: { 'content-type': 'audio/mpeg' } })
        if (url.pathname.endsWith('/files/image')) return new Response(png, { headers: { 'content-type': 'image/png' } })
        if (path === 'docs') return Response.json({ path: 'docs', entries: listed(false) })
        return Response.json({ path: '', entries: [entry('docs', 'dir')] })
    }))
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => { root.render(<DesktopCoworkerFiles agent={alice} />) })
    await click('Files')
    await flush()
    await click('docs')
    await flush()
    await click('alpha.md')
    await flush()
    expect(document.body.textContent).toContain('Loading preview…')
    expect(button('Next file')).toBeDefined()
    expect(document.body.textContent).toContain('1 / 4')

    await key('ArrowLeft')
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Could not preview this file.')
    expect(button('Previous file')).toBeDefined()
    expect(document.body.textContent).toContain('4 / 4')
    await act(async () => { release?.(Response.json({ path: 'docs/alpha.md', content: 'alpha body', size: 10, truncated: false, hash: 'abc', identity: '1:1' })) })
    await flush()
    expect(document.body.textContent).not.toContain('alpha body')
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Could not preview this file.')
    act(() => root.unmount())
})

test('arrow keys move between files except while typing, holding a modifier, or inside a menu, dialog, or media control', async () => {
    const root = await openDocs()
    await click('alpha.md')
    await flush()
    await key('ArrowRight', { shiftKey: true })
    expect(document.querySelector('[data-testid="file-preview"]')?.textContent).toBe('alpha body')
    await key('ArrowRight', { metaKey: true })
    expect(document.querySelector('[data-testid="file-preview"]')?.textContent).toBe('alpha body')

    const filesDialog = document.querySelector('[data-testid="file-preview"]')!.closest('[role="dialog"]')!
    const field = document.createElement('input')
    filesDialog.append(field)
    field.focus()
    expect(document.activeElement).toBe(field)
    await key('ArrowRight', {}, field)
    expect(document.querySelector('[data-testid="file-preview"]')?.textContent).toBe('alpha body')
    field.remove()

    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    const item = document.createElement('button')
    menu.append(item)
    // Keep the synthetic overlay inside Files' real focus trap, outside its viewer.
    filesDialog.append(menu)
    item.focus()
    expect(document.activeElement).toBe(item)
    await key('ArrowRight', {}, item)
    expect(document.querySelector('[data-testid="file-preview"]')?.textContent).toBe('alpha body')
    menu.remove()

    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    const trap = document.createElement('button')
    dialog.append(trap)
    filesDialog.append(dialog)
    trap.focus()
    expect(document.activeElement).toBe(trap)
    await key('ArrowRight', {}, trap)
    expect(document.querySelector('[data-testid="file-preview"]')?.textContent).toBe('alpha body')
    dialog.remove()

    await key('ArrowRight')
    expect(document.querySelector('[data-testid="file-audio-preview"]')).not.toBeNull()
    const player = document.querySelector<HTMLAudioElement>('[data-testid="file-audio-preview"]')
    player?.focus()
    const seeking = await key('ArrowRight', {}, player ?? window)
    expect(seeking.defaultPrevented).toBe(false)
    expect(document.querySelector('[data-testid="file-audio-preview"]')).not.toBeNull()
    expect(document.body.textContent).toContain('2 / 4')
    act(() => root.unmount())
})

test('edit and conflict hide the arrows', async () => {
    const root = await openDocs()
    await click('alpha.md')
    await flush()
    await click('Edit')
    expect(button('Previous file')).toBeUndefined()
    expect(document.querySelector('[aria-label="Edit alpha.md"]')).not.toBeNull()
    await key('ArrowRight')
    expect(document.querySelector('[aria-label="Edit alpha.md"]')).not.toBeNull()
    expect(document.body.textContent).not.toContain('zeta body')
    act(() => root.unmount())

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'http://127.0.0.1')
        const path = url.searchParams.get('path') ?? ''
        if (url.pathname.endsWith('/files/read')) return Response.json({ error: 'changed', conflict: true, current: { content: 'disk copy', hash: 'abc' } }, { status: 409 })
        if (path === 'docs') return Response.json({ path: 'docs', entries: listed(false) })
        return Response.json({ path: '', entries: [entry('docs', 'dir')] })
    }))
    const container = document.createElement('div')
    document.body.append(container)
    const conflict = createRoot(container)
    await act(async () => { conflict.render(<DesktopCoworkerFiles agent={alice} />) })
    await click('Files')
    await flush()
    await click('docs')
    await flush()
    await click('alpha.md')
    await flush()
    expect(document.querySelector('[data-testid="conflict-disk"]')?.textContent).toBe('disk copy')
    expect(button('Previous file')).toBeUndefined()
    await key('ArrowRight')
    expect(document.querySelector('[data-testid="conflict-disk"]')?.textContent).toBe('disk copy')
    act(() => conflict.unmount())
})

test.each(['replaced', 'failed'] as const)('an import-triggered %s listing cannot discard the open editor draft', async reloadResult => {
    let finishImport!: (response: Response) => void
    const imported = new Promise<Response>(resolve => { finishImport = resolve })
    let listings = 0
    let reads = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://127.0.0.1')
        if (init?.method === 'POST') return imported
        if (url.pathname.endsWith('/files/read')) {
            reads++
            const replaced = listings > 1 && reloadResult === 'replaced'
            return Response.json({ path: 'alpha.md', content: replaced ? 'new disk copy' : 'alpha body', truncated: false, hash: replaced ? 'def' : 'abc', identity: replaced ? '2:1' : '1:1' })
        }
        listings++
        if (listings > 1 && reloadResult === 'failed') return Response.json({ error: 'Could not open this folder.' }, { status: 500 })
        return Response.json({ path: '', entries: [entry('alpha.md', 'file', listings > 1 ? '2:1' : '1:1'), entry('zeta.txt', 'file', '9:1')] })
    }))
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    try {
        await act(async () => { root.render(<DesktopCoworkerFiles agent={alice} />) })
        await click('Files')
        await flush()
        const input = document.querySelector<HTMLInputElement>('[data-testid="files-import-file-input"]')!
        Object.defineProperty(input, 'files', { configurable: true, value: [new File(['imported'], 'new.md')] })
        await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
        await click('alpha.md')
        await flush()
        await click('Edit')
        const editor = document.querySelector<HTMLTextAreaElement>('[aria-label="Edit alpha.md"]')!
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
        await act(async () => {
            setter.call(editor, 'my unsaved draft')
            editor.dispatchEvent(new Event('input', { bubbles: true }))
        })
        expect(button('Save changes')?.disabled).toBe(false)

        await act(async () => { finishImport(Response.json({ saved: true, path: 'new.md' })) })
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 500)) })
        await flush()
        expect(listings).toBe(2)
        expect(reads).toBe(1)
        expect(document.querySelector('[aria-label="Edit alpha.md"]')).toBe(editor)
        expect(editor.value).toBe('my unsaved draft')
        expect(button('Next file')).toBeUndefined()

        await click('Cancel')
        expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('Discard your changes?')
        await click('Keep editing')
        expect(editor.value).toBe('my unsaved draft')
        await click('Cancel')
        await click('Discard changes')
        await flush()
        expect(document.querySelector('[data-testid="file-preview"]')?.textContent).toBe(reloadResult === 'replaced' ? 'new disk copy' : 'alpha body')
        expect(reads).toBe(2)
    } finally { act(() => root.unmount()) }
})

test('back returns to the same folder', async () => {
    const root = await openDocs()
    await click('alpha.md')
    await flush()
    await click('Back to folder')
    await flush()
    expect(document.querySelector('[data-testid="file-preview"]')).toBeNull()
    expect(button('alpha.md')).toBeDefined()
    expect(button('beta')).toBeDefined()
    expect(button('Workspace home')).toBeDefined()
    act(() => root.unmount())
})

test('a new file or coworker does not keep the previous preview', async () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause')
    const revoke = vi.spyOn(URL, 'revokeObjectURL')
    const root = await openDocs()
    await click('mid.mp3')
    await flush()
    expect(document.querySelector('[data-testid="file-audio-preview"]')).not.toBeNull()
    await click('Next file')
    await flush()
    expect(pause).toHaveBeenCalled()
    expect(document.querySelector('[data-testid="file-audio-preview"]')).toBeNull()
    expect(document.querySelector('[data-testid="file-image-preview"]')?.getAttribute('alt')).toBe('photo.png')
    await click('Next file')
    await flush()
    expect(revoke).toHaveBeenCalled()
    expect(document.querySelector('[data-testid="file-image-preview"]')).toBeNull()
    expect(document.querySelector('[data-testid="file-preview"]')?.textContent).toBe('zeta body')

    await act(async () => { root.render(<DesktopCoworkerFiles agent={{ ...alice, id: 'bob', name: 'Bob' }} />) })
    await flush()
    expect(document.body.textContent).not.toContain('zeta body')
    expect(document.querySelector('[data-testid="file-preview"]')).toBeNull()
    expect(button('other.txt')).toBeDefined()
    act(() => root.unmount())
})
