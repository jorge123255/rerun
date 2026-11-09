// @vitest-environment happy-dom
import { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import type { SharedFilesTree } from '@/components/brain/useSharedFilesTree'
import { SHARED_FILE_DRAG_TYPE } from '@/components/brain/editor/file-link'
import { BrainSidebar } from './BrainSidebar'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const files: SharedFilesTree = {
    entriesOf: dir => dir === '' ? [
        { name: 'notes', type: 'dir', size: 0, modified: '' },
        { name: 'readme.md', type: 'file', size: 12, modified: '' },
    ] : [],
    expanded: new Set<string>(),
    toggle: () => {},
    expand: () => {},
    refresh: async () => {},
    knownFiles: [
        { path: 'readme.md', name: 'readme.md' },
        { path: 'notes/q3.pdf', name: 'q3.pdf' },
    ],
}

let root: Root | undefined
afterEach(async () => {
    if (root) await act(async () => root!.unmount())
    root = undefined
    document.body.innerHTML = ''
})

async function mount(extra: { fileDrag?: boolean; fileDropWorkspace?: string } = {}) {
    const node = document.createElement('div')
    document.body.append(node)
    root = createRoot(node)
    await act(async () => {
        root!.render(<BrainSidebar pages={[]} pagesAvailable selection={null} openProposals={0} files={files} tables={[]} searchRef={createRef()} onSelect={() => {}} onUpload={() => {}} fileDrag fileDropWorkspace="1" {...extra} />)
    })
}

function rows(draggable?: boolean) {
    const selector = draggable === undefined ? 'aside [role="button"], [role="button"]' : `[role="button"][draggable="${draggable ? 'true' : 'false'}"]`
    return [...document.querySelectorAll<HTMLElement>(selector)]
}

function row(label: string) {
    return rows().find(node => (node.textContent || '').replace(/\s+/g, ' ').trim() === label)
}

function drag(node: HTMLElement) {
    const store = new Map<string, string>()
    let effectAllowed = ''
    const event = new Event('dragstart', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', {
        value: {
            get effectAllowed() { return effectAllowed },
            set effectAllowed(value: string) { effectAllowed = value },
            setData(type: string, value: string) { store.set(type, value) },
            getData(type: string) { return store.get(type) ?? '' },
        },
    })
    node.dispatchEvent(event)
    return { store, effectAllowed }
}

it('drags a listed file with its workspace and does not drag a directory', async () => {
    await mount()
    const file = row('readme.md')
    expect(file?.getAttribute('draggable')).toBe('true')
    expect(rows().some(node => (node.textContent || '').includes('notes') && node.getAttribute('draggable') === 'true')).toBe(false)
    const started = drag(file!)
    expect(started.effectAllowed).toBe('copy')
    expect(JSON.parse(started.store.get(SHARED_FILE_DRAG_TYPE) ?? '')).toEqual({ path: 'readme.md', name: 'readme.md', workspace: '1' })
})

it('drags a search hit with the same workspace', async () => {
    await mount()
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Search pages and files"]')
    if (!input) throw new Error('missing search')
    await act(async () => {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
        set?.call(input, 'q3')
        input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const hit = row('notes/q3.pdf')
    expect(hit?.getAttribute('draggable')).toBe('true')
    const started = drag(hit!)
    expect(JSON.parse(started.store.get(SHARED_FILE_DRAG_TYPE) ?? '')).toEqual({ path: 'notes/q3.pdf', name: 'q3.pdf', workspace: '1' })
})

it('omits the workspace for a hosted drag and drops the gesture when file drag is off', async () => {
    await mount({ fileDropWorkspace: undefined })
    const hosted = drag(row('readme.md')!)
    expect(JSON.parse(hosted.store.get(SHARED_FILE_DRAG_TYPE) ?? '')).toEqual({ path: 'readme.md', name: 'readme.md' })
    await act(async () => root!.unmount())
    root = undefined
    document.body.innerHTML = ''
    await mount({ fileDrag: false, fileDropWorkspace: undefined })
    expect(document.querySelector('[draggable="true"]')).toBeNull()
})
