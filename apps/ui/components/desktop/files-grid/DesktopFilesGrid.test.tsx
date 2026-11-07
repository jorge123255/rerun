// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { DesktopFilesGrid, type DesktopFilesGridEntry } from './DesktopFilesGrid'
import { DESKTOP_FILES_EMPTY_LABEL } from './model'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const base = '/api/desktop/agents/alice/files'

class ImmediateObserver {
    constructor(private readonly notify: IntersectionObserverCallback) {}
    observe() { this.notify([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver) }
    disconnect() {}
    unobserve() {}
    takeRecords() { return [] }
    root = null
    rootMargin = ''
    thresholds = []
}

class HiddenObserver {
    observe() {}
    disconnect() {}
    unobserve() {}
    takeRecords() { return [] }
    root = null
    rootMargin = ''
    thresholds = []
}

const entry = (name: string, type: DesktopFilesGridEntry['type'], size = 20, identity?: string): DesktopFilesGridEntry => ({ name, type, size, ...(identity && { identity }) })

let root: Root | null = null
let container: HTMLDivElement | null = null

beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', ImmediateObserver)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
})

afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    root = null
    container = null
    vi.unstubAllGlobals()
})

async function render(props: Partial<ComponentProps<typeof DesktopFilesGrid>> & { entries: readonly DesktopFilesGridEntry[] }) {
    await act(async () => {
        root?.render(
            <DesktopFilesGrid
                currentPath=""
                filesBase={base}
                onOpenFile={() => {}}
                onOpenDir={() => {}}
                {...props}
            />
        )
    })
}

const tile = (name: string) => document.querySelector(`[data-files-name="${name}"]`)
const names = () => [...document.querySelectorAll('[data-files-name]')].map(node => node.getAttribute('data-files-name'))

test('folders lead the grid and each file keeps its own type glyph', async () => {
    await render({ entries: [entry('zebra.txt', 'file'), entry('docs', 'dir'), entry('clip.mp4', 'file'), entry('song.mp3', 'file'), entry('bundle.zip', 'file'), entry('index.ts', 'file')] })
    expect(document.querySelector('[data-testid="desktop-files-grid"]')?.className).toContain('minmax(84px,1fr)')
    const files = ['bundle.zip', 'clip.mp4', 'index.ts', 'song.mp3', 'zebra.txt']
    expect(names()).toEqual(['docs', ...[...files].sort((a, b) => a.localeCompare(b))])
    expect(tile('docs')?.querySelector('[data-files-thumb="folder"]')).not.toBeNull()
    expect(tile('clip.mp4')?.querySelector('[data-files-kind="video"] [data-files-type-icon]')).not.toBeNull()
    expect(tile('song.mp3')?.querySelector('[data-files-kind="audio"] [data-files-type-icon]')).not.toBeNull()
    expect(tile('bundle.zip')?.querySelector('[data-files-kind="binary"] [data-files-type-icon]')).not.toBeNull()
    expect(tile('index.ts')?.querySelector('[data-files-kind="text"] [data-files-type-icon]')).not.toBeNull()
    expect(tile('zebra.txt')?.querySelector('[data-files-type-icon]')).toBeNull()
    expect(tile('zebra.txt')?.querySelector('.uppercase')?.textContent).toBe('txt')
    expect(document.querySelector('img')).toBeNull()
})

test('a small image uses the desktop image route and a refusal falls back to the sheet once', async () => {
    await render({ currentPath: 'shots', entries: [entry('photo.png', 'file', 100, '12:34'), entry('huge.png', 'file', 3_000_001)] })
    const image = tile('photo.png')?.querySelector('img')
    expect(image?.getAttribute('src')).toBe(`${base}/image?path=shots%2Fphoto.png&identity=12%3A34`)
    expect(image?.getAttribute('alt')).toBe('photo.png')
    expect(tile('huge.png')?.querySelector('img')).toBeNull()
    expect(tile('huge.png')?.querySelector('[data-files-thumb="glyph"]')).not.toBeNull()
    await act(async () => { image?.dispatchEvent(new Event('error')) })
    expect(tile('photo.png')?.querySelector('img')).toBeNull()
    expect(tile('photo.png')?.querySelector('[data-files-thumb="glyph"]')).not.toBeNull()
    expect(tile('photo.png')?.querySelector('.uppercase')?.textContent).toBe('png')
})

test('an in-place image revision gives a previously refused thumbnail a fresh URL', async () => {
    const photo = entry('photo.png', 'file', 100, '12:34')
    const revision = '2026-11-03T12:00:00.000Z'
    await render({ entries: [{ ...photo, modifiedAt: revision }] })
    const image = tile('photo.png')?.querySelector('img')
    const first = new URL(image!.getAttribute('src')!, 'http://127.0.0.1')
    expect(first.searchParams.get('revision')).toBe(revision)
    await act(async () => image!.dispatchEvent(new Event('error')))
    expect(tile('photo.png')?.querySelector('img')).toBeNull()

    await render({ entries: [{ ...photo, modifiedAt: revision }] })
    expect(tile('photo.png')?.querySelector('img')).toBeNull()

    const nextRevision = '2026-11-03T12:00:01.000Z'
    await render({ entries: [{ ...photo, modifiedAt: nextRevision }] })
    const next = new URL(tile('photo.png')!.querySelector('img')!.getAttribute('src')!, 'http://127.0.0.1')
    expect(next.pathname).toBe(first.pathname)
    expect(next.searchParams.get('path')).toBe('photo.png')
    expect(next.searchParams.get('identity')).toBe('12:34')
    expect(next.searchParams.get('revision')).toBe(nextRevision)
})

test('a text head replaces the extension badge, and an empty head does not', async () => {
    await render({
        entries: [entry('notes.md', 'file'), entry('plain.txt', 'file')],
        textHeads: { 'notes.md': '# Hello', 'plain.txt': '' },
    })
    expect(tile('notes.md')?.querySelector('[data-files-thumb="text"] pre')?.textContent).toContain('# Hello')
    expect(tile('notes.md')?.querySelector('.uppercase')).toBeNull()
    expect(tile('plain.txt')?.querySelector('pre')).toBeNull()
    expect(tile('plain.txt')?.querySelector('.uppercase')?.textContent).toBe('txt')
})

test('only a visible small text file asks for a head', async () => {
    const onRequestText = vi.fn()
    await render({
        currentPath: 'docs',
        entries: [entry('notes.md', 'file', 12), entry('photo.png', 'file', 3_000_001), entry('big.md', 'file', 262_145), entry('docs', 'dir', 0)],
        onRequestText,
    })
    expect(onRequestText).toHaveBeenCalledTimes(1)
    expect(onRequestText).toHaveBeenCalledWith('docs/notes.md')
})

test('a text file off screen does not ask for a head', async () => {
    vi.stubGlobal('IntersectionObserver', HiddenObserver)
    const onRequestText = vi.fn()
    await render({ entries: [entry('notes.md', 'file')], onRequestText })
    expect(onRequestText).not.toHaveBeenCalled()
})

test('reserved aliases are omitted and an ordinary hidden file stays', async () => {
    await render({ entries: [entry('internal.rerun.box', 'file'), entry('.rerun-skill-lock', 'dir'), entry('.env', 'file'), entry('notes.md', 'file')] })
    expect(names()).toEqual(['.env', 'notes.md'].sort((a, b) => a.localeCompare(b)))
    expect(names()).not.toContain('internal.rerun.box')
    expect(names()).not.toContain('.rerun-skill-lock')
})

test('open, parent, and menu stay on the names the panel already handles', async () => {
    const onOpenFile = vi.fn()
    const onOpenDir = vi.fn()
    const onGoUp = vi.fn()
    const onContextMenu = vi.fn()
    const onClearMenu = vi.fn()
    await render({
        currentPath: 'docs',
        entries: [entry('notes.md', 'file'), entry('inner', 'dir')],
        selectedName: 'notes.md',
        onOpenFile,
        onOpenDir,
        onGoUp,
        onContextMenu,
        onClearMenu,
    })
    expect(tile('notes.md')?.getAttribute('aria-selected')).toBe('true')
    await act(async () => { (tile('notes.md') as HTMLButtonElement).click() })
    expect(onOpenFile).toHaveBeenCalledWith('notes.md')
    expect(onOpenDir).not.toHaveBeenCalled()
    await act(async () => { (tile('inner') as HTMLButtonElement).click() })
    expect(onOpenDir).toHaveBeenCalledWith('inner')
    tile('notes.md')?.dispatchEvent(new Event('contextmenu', { bubbles: true }))
    expect(onContextMenu).toHaveBeenCalledWith('notes.md')
    const parent = document.querySelector('button[aria-label=".."]')
    expect(parent?.textContent).toContain('..')
    const menu = new Event('contextmenu', { bubbles: true, cancelable: true })
    parent?.dispatchEvent(menu)
    expect(menu.defaultPrevented).toBe(true)
    expect(onClearMenu).toHaveBeenCalledTimes(1)
    expect(onContextMenu).toHaveBeenCalledTimes(1)
    await act(async () => { (parent as HTMLButtonElement).click() })
    expect(onGoUp).toHaveBeenCalledTimes(1)
})

test('a pending tile does not open, and rename stays in the caller field', async () => {
    const onOpenFile = vi.fn()
    await render({ entries: [entry('notes.md', 'file')], pending: true, onOpenFile })
    const button = tile('notes.md') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    await act(async () => { button.click() })
    expect(onOpenFile).not.toHaveBeenCalled()
    await render({
        entries: [entry('notes.md', 'file')],
        renamingName: 'notes.md',
        renderRename: name => <input aria-label="New name" defaultValue={name} />,
        onOpenFile,
    })
    expect(document.querySelector('[data-files-name="notes.md"] button')).toBeNull()
    expect(document.querySelector('input[aria-label="New name"]')).not.toBeNull()
    expect(onOpenFile).not.toHaveBeenCalled()
})

test('an empty folder keeps the coworker empty sentence and the parent tile', async () => {
    const onGoUp = vi.fn()
    await render({ currentPath: 'docs', entries: [], onGoUp })
    expect(document.querySelector('[data-testid="desktop-files-grid"]')?.textContent).toContain(DESKTOP_FILES_EMPTY_LABEL)
    expect(document.querySelector('button[aria-label=".."]')).not.toBeNull()
})
