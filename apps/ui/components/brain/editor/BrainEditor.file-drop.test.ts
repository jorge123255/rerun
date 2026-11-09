// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import { afterEach, describe, expect, it } from 'vitest'
import { acceptedSharedFileDrop } from '@/components/desktop/brain/pages/shared-file-link'
import { brainExtensions, editorMarkdown } from './extensions'
import { insertSharedFileDrop, SHARED_FILE_DRAG_TYPE, sharedFileDragData } from './file-link'

const listed = [{ path: 'readme.md', name: 'readme.md' }]
const accept = (raw: string) => acceptedSharedFileDrop(raw, listed, '1')
const editors: Editor[] = []

afterEach(() => {
    for (const editor of editors.splice(0)) editor.destroy()
})

function open(content = 'Hello world') {
    const editor = new Editor({ extensions: brainExtensions(), content })
    editors.push(editor)
    return editor
}

function drop(editor: Editor, raw: string | null, options: { pos?: number | null; accept?: ((raw: string) => { path: string; name: string } | null) | null; editable?: boolean; text?: string } = {}) {
    if (options.editable === false) editor.setEditable(false)
    const view = editor.view
    const pos = options.pos === undefined ? 6 : options.pos
    view.posAtCoords = () => (pos === null ? null : { pos, inside: -1 })
    let prevented = false
    const result = insertSharedFileDrop(view, {
        clientX: 12,
        clientY: 12,
        preventDefault() { prevented = true },
        dataTransfer: {
            getData: type => {
                if (type === SHARED_FILE_DRAG_TYPE) return raw ?? ''
                if (type === 'text/plain') return options.text ?? ''
                return ''
            },
        },
    }, options.accept === null ? undefined : (options.accept ?? accept))
    return { result, prevented, markdown: editorMarkdown(editor) }
}

describe('insertSharedFileDrop', () => {
    it('inserts the listed shared link at the drop position and does not add a trailing space', () => {
        const editor = open()
        const landed = drop(editor, sharedFileDragData({ path: 'readme.md', name: 'readme.md' }, '1'))
        expect(landed.result).toBe(true)
        expect(landed.prevented).toBe(true)
        expect(landed.markdown).toBe('Hello[readme.md](shared:readme.md) world')
    })

    it('leaves a text drop and a drop with no position to the editor', () => {
        const editor = open()
        const text = drop(editor, null, { text: 'plain words' })
        expect(text.result).toBe(false)
        expect(text.prevented).toBe(false)
        expect(text.markdown).toBe('Hello world')
        const missed = drop(editor, sharedFileDragData({ path: 'readme.md', name: 'readme.md' }, '1'), { pos: null })
        expect(missed.result).toBe(false)
        expect(missed.prevented).toBe(false)
        expect(missed.markdown).toBe('Hello world')
    })

    it('pastes plain text through the editor when no paste handler is installed', () => {
        const editor = open('Hello')
        editor.commands.focus('end')
        const clipboard = new DataTransfer()
        clipboard.setData('text/plain', ' there')
        const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard })
        editor.view.dom.dispatchEvent(event)
        expect(editor.getText()).toBe('Hello there')
    })

    it.each([
        ['garbage', '{'],
        ['forged name', sharedFileDragData({ path: 'readme.md', name: 'other.md' }, '1')],
        ['other workspace', sharedFileDragData({ path: 'readme.md', name: 'readme.md' }, '2')],
        ['traversal', sharedFileDragData({ path: '../secret.md', name: 'secret.md' }, '1')],
        ['directory', JSON.stringify({ path: 'notes', name: 'notes', type: 'dir', workspace: '1' })],
        ['unlisted', sharedFileDragData({ path: 'missing.md', name: 'missing.md' }, '1')],
    ])('refuses a %s drop without throwing or inserting', (_label, raw) => {
        const editor = open()
        expect(() => drop(editor, raw)).not.toThrow()
        const landed = drop(editor, raw)
        expect(landed.result).toBe(true)
        expect(landed.prevented).toBe(true)
        expect(landed.markdown).toBe('Hello world')
    })

    it('does not insert into a read-only editor', () => {
        const editor = open()
        const landed = drop(editor, sharedFileDragData({ path: 'readme.md', name: 'readme.md' }, '1'), { editable: false })
        expect(landed.result).toBe(true)
        expect(landed.prevented).toBe(true)
        expect(landed.markdown).toBe('Hello world')
    })

    it('does not throw when a hosted drop is not json', () => {
        const editor = open()
        const landed = drop(editor, '{', { accept: null })
        expect(landed.result).toBe(true)
        expect(landed.prevented).toBe(true)
        expect(landed.markdown).toBe('Hello world')
    })

    it('keeps the hosted insert when no desktop check is supplied', () => {
        const editor = open()
        const landed = drop(editor, sharedFileDragData({ path: 'notes/q3.pdf', name: 'q3.pdf' }), { accept: null })
        expect(landed.markdown).toBe('Hello[q3.pdf](shared:notes/q3.pdf) world')
    })
})
