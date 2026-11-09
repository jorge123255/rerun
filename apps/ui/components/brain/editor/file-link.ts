import { mergeAttributes, Node } from '@tiptap/core'
import type { EditorView } from '@tiptap/pm/view'
import type { MarkdownNodeSpec } from 'tiptap-markdown'

export type FileLinkAttrs = { path: string; name: string }

type FileLinkOptions = { onOpen: (path: string) => void }

export const SHARED_FILE_SCHEME = 'shared:'

// Dragged from the Files tree of the sidebar onto a page.
export const SHARED_FILE_DRAG_TYPE = 'application/x-rerun-shared-file'

export type SharedFileDrag = { path: string; name: string; workspace?: string }

// The hosted sidebar omits `workspace`. Desktop sets it to the active workspace.
export function sharedFileDragData(file: { path: string; name: string }, workspace?: string): string {
    const payload: SharedFileDrag = workspace ? { path: file.path, name: file.name, workspace } : { path: file.path, name: file.name }
    return JSON.stringify(payload)
}

// A directory, a non-object, or any field outside the drag contract is not a file link.
export function readSharedFileDrag(raw: string): SharedFileDrag | null {
    let parsed: unknown
    try {
        parsed = JSON.parse(raw) as unknown
    } catch {
        return null
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    for (const key of Object.keys(record)) {
        if (key !== 'path' && key !== 'name' && key !== 'workspace' && key !== 'type') return null
    }
    if (record.type !== undefined && record.type !== 'file') return null
    if (typeof record.path !== 'string' || typeof record.name !== 'string') return null
    if (record.workspace !== undefined && typeof record.workspace !== 'string') return null
    return { path: record.path, name: record.name, ...(typeof record.workspace === 'string' ? { workspace: record.workspace } : {}) }
}

type SharedFileDropEvent = {
    dataTransfer?: { getData(type: string): string } | null
    clientX: number
    clientY: number
    preventDefault(): void
}

// The original sidebar drop: the pointer position, then one file-link node and no trailing space.
// Desktop passes `accept` so only a listed file of the active workspace is inserted. Hosted omits
// it and keeps that insert. A payload that is not JSON does not throw.
export function insertSharedFileDrop(view: EditorView, event: SharedFileDropEvent, accept?: (raw: string) => { path: string; name: string } | null): boolean {
    const raw = event.dataTransfer?.getData(SHARED_FILE_DRAG_TYPE)
    if (!raw) return false
    if (!view.editable) {
        event.preventDefault()
        return true
    }
    const position = view.posAtCoords({ left: event.clientX, top: event.clientY })
    if (!position) return false
    const file = accept ? accept(raw) : hostedSharedFileDrag(raw)
    if (!file) {
        event.preventDefault()
        return true
    }
    const fileLink = view.state.schema.nodes.fileLink
    if (!fileLink) {
        event.preventDefault()
        return true
    }
    event.preventDefault()
    const node = fileLink.create({ path: file.path, name: file.name })
    view.dispatch(view.state.tr.insert(position.pos, node))
    view.focus()
    return true
}

function hostedSharedFileDrag(raw: string): { path: string; name: string } | null {
    try {
        const parsed = JSON.parse(raw) as { path?: unknown; name?: unknown } | null
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
        if (typeof parsed.path !== 'string' || typeof parsed.name !== 'string') return null
        return { path: parsed.path, name: parsed.name }
    } catch {
        return null
    }
}

const fileName = (path: string) => path.split('/').filter(Boolean).pop() ?? path

// Angle brackets keep a path with spaces or parentheses in one destination, and leave it readable
// to an agent reading the raw page.
export function fileLinkMarkdown({ path, name }: FileLinkAttrs): string {
    const label = name.replace(/([\\[\]])/g, '\\$1')
    const destination = /[\s()<>]/.test(path) ? `<${SHARED_FILE_SCHEME}${path.replace(/>/g, '%3E')}>` : `${SHARED_FILE_SCHEME}${path}`
    return `[${label}](${destination})`
}

function decodePath(href: string): string {
    const raw = href.slice(SHARED_FILE_SCHEME.length)
    try {
        return decodeURI(raw)
    } catch {
        return raw
    }
}

// The outline file glyph of the Nucleo pack: the node view is plain DOM, outside React.
const FILE_GLYPH =
    '<svg viewBox="0 0 18 18" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15.16,6.25h-3.41c-.552,0-1-.448-1-1V1.852"/><path d="M2.75,14.25V3.75c0-1.105,.895-2,2-2h5.586c.265,0,.52,.105,.707,.293l3.914,3.914c.188,.188,.293,.442,.293,.707v7.586c0,1.105-.895,2-2,2H4.75c-1.105,0-2-.895-2-2Z"/></svg>'

// A file of the shared folder cited on a page: `[q3.pdf](shared:reports/q3.pdf)` in the markdown,
// a chip in the editor. Agents read the same path with shared_read.
export const FileLink = Node.create<FileLinkOptions>({
    name: 'fileLink',
    group: 'inline',
    inline: true,
    atom: true,
    selectable: true,
    draggable: true,

    addOptions() {
        return { onOpen: () => {} }
    },

    addAttributes() {
        return {
            path: { default: '', parseHTML: element => element.getAttribute('data-file-link') ?? '', renderHTML: attrs => ({ 'data-file-link': attrs.path }) },
            name: { default: '', parseHTML: element => element.textContent || fileName(element.getAttribute('data-file-link') ?? ''), renderHTML: () => ({}) },
        }
    },

    parseHTML() {
        return [{ tag: 'span[data-file-link]' }]
    },

    renderHTML({ node, HTMLAttributes }) {
        return ['span', mergeAttributes(HTMLAttributes), (node.attrs as FileLinkAttrs).name]
    },

    renderText({ node }) {
        return fileLinkMarkdown(node.attrs as FileLinkAttrs)
    },

    addNodeView() {
        return ({ node }) => {
            const { path, name } = node.attrs as FileLinkAttrs
            const dom = document.createElement('span')
            dom.dataset.fileLink = path
            dom.title = path
            dom.className =
                'mx-0.5 inline-flex cursor-pointer items-center gap-1 rounded-md border border-border bg-muted/40 px-1.5 py-px align-baseline text-[0.9em] font-medium text-foreground transition-colors hover:bg-accent'
            dom.innerHTML = FILE_GLYPH
            const label = document.createElement('span')
            label.textContent = name || fileName(path)
            dom.append(label)
            dom.addEventListener('click', event => {
                event.preventDefault()
                this.options.onOpen(path)
            })
            return { dom }
        }
    },

    addStorage() {
        const markdown: MarkdownNodeSpec = {
            serialize(state, node) {
                state.write(fileLinkMarkdown(node.attrs as FileLinkAttrs))
            },
            parse: {
                updateDOM(element) {
                    for (const anchor of element.querySelectorAll(`a[href^="${SHARED_FILE_SCHEME}"]`)) {
                        const chip = element.ownerDocument.createElement('span')
                        chip.setAttribute('data-file-link', decodePath(anchor.getAttribute('href') ?? ''))
                        chip.textContent = anchor.textContent
                        anchor.replaceWith(chip)
                    }
                },
            },
        }
        return { markdown }
    },
})
