// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { cancelDraftShutdown, flushDesktopDrafts } from '@/lib/desktop/draft-writes'
import { DesktopBrainFile } from './DesktopBrainFiles'
import { DesktopSharedFilePreview } from '../../shared-files/DesktopSharedFilePreview'

vi.mock('@/components/files/FileTextEditor', () => ({
    FileTextEditor: ({ value, onChange, readOnly }: { value: string; onChange: (text: string) => void; readOnly: boolean }) => (
        <textarea aria-label="File contents" value={value} onChange={event => onChange(event.target.value)} readOnly={readOnly} />
    ),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const path = 'docs/note.md'
const original = { expectedBytes: 10, expectedSha256: '1'.repeat(64) }
const saved = { expectedBytes: 7, expectedSha256: '2'.repeat(64) }
let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
let fetchFile: ReturnType<typeof vi.fn>
let refresh: ReturnType<typeof vi.fn>
let files: ComponentProps<typeof DesktopBrainFile>['files']

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    refresh = vi.fn(async () => {})
    files = { expand: vi.fn(), refresh, entriesOf: () => [] } as unknown as typeof files
    fetchFile = vi.fn(async () => Response.json({ path, content: 'original\r\n', truncated: false, editIdentity: original }))
    vi.stubGlobal('fetch', fetchFile)
})

afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
})

const button = (label: string) => Array.from(document.querySelectorAll('button')).find(node => node.textContent?.trim() === label)
const click = async (label: string) => {
    const target = button(label)
    expect(target, label).toBeDefined()
    await act(async () => target?.click())
}
const field = () => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="File contents"]')!
async function edit(value: string) {
    await act(async () => {
        const textarea = field()
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, value)
        textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
}

test('Brain Files saves the captured revision, preserves CRLF, and uses the returned revision for the next edit', async () => {
    fetchFile.mockImplementation(async (_url, init?: RequestInit) => init?.method === 'PUT'
        ? Response.json({ ok: true, workspaceId: 2, path, editIdentity: saved, recoveryPath: 'docs/shared-edit-recovery-example.md' })
        : Response.json({ path, content: 'original\r\n', truncated: false, editIdentity: original }))
    await act(async () => root.render(<DesktopBrainFile path={path} workspaceId={2} files={files} onSelect={vi.fn()} />))
    await click('Edit')
    expect(field().value).toBe('original\n')
    await edit('saved\n')
    await click('Save changes')
    expect(JSON.parse(fetchFile.mock.calls[1][1].body)).toEqual({ workspaceId: 2, path, content: 'saved\r\n', base: original })
    expect(refresh).toHaveBeenCalledWith('docs')
    await edit('new draft\n')
    await click('Save changes')
    expect(JSON.parse(fetchFile.mock.calls[2][1].body)).toEqual({ workspaceId: 2, path, content: 'new draft\r\n', base: saved })
})

test('a stale save retains the draft and requires reopening without offering an overwrite', async () => {
    fetchFile.mockImplementation(async (_url, init?: RequestInit) => init?.method === 'PUT'
        ? Response.json({ error: 'This file changed. Reopen it before saving again.' }, { status: 409 })
        : Response.json({ path, content: 'original\r\n', truncated: false, editIdentity: original }))
    await act(async () => root.render(<DesktopBrainFile path={path} workspaceId={2} files={files} onSelect={vi.fn()} />))
    await click('Edit')
    await edit('my unsaved draft')
    await click('Save changes')
    expect(field().value).toBe('my unsaved draft')
    expect(document.body.textContent).toContain('This file changed. Reopen it before saving again.')
    expect(button('Overwrite')).toBeUndefined()
    await click('Save changes')
    expect(fetchFile).toHaveBeenCalledTimes(2)
    expect(refresh).not.toHaveBeenCalled()
    await click('Cancel')
    await click('Discard changes')
    expect(fetchFile).toHaveBeenCalledTimes(3)
})

test('a workspace Files preview and a truncated Brain preview do not mount an editor', async () => {
    await act(async () => root.render(<DesktopSharedFilePreview path={path} entries={[]} onOpen={vi.fn()} />))
    expect(button('Edit')).toBeUndefined()
    fetchFile.mockResolvedValueOnce(Response.json({ path, content: 'partial', truncated: true, editIdentity: original }))
    await act(async () => root.render(<DesktopBrainFile path={path} workspaceId={2} files={files} onSelect={vi.fn()} />))
    expect(button('Edit')).toBeUndefined()
})


test('native quit requires confirmation for an unsaved Brain file and Stay preserves the draft', async () => {
    vi.stubGlobal('desktopApp', { onBeforeQuit: vi.fn() })
    try {
        await act(async () => root.render(<DesktopBrainFile path={path} workspaceId={2} files={files} onSelect={vi.fn()} />))
        await click('Edit')
        await edit('draft to keep')
        expect(window.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(false)
        await act(async () => { expect(await flushDesktopDrafts()).toBe(false) })
        expect(fetchFile).toHaveBeenCalledTimes(1)
        // The native dialog owns the choice to discard, including the subsequent unload.
        expect(window.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(true)
        act(cancelDraftShutdown)
        expect(field().value).toBe('draft to keep')
        expect(window.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(false)
        await click('Cancel')
        await click('Discard changes')
        await act(async () => { expect(await flushDesktopDrafts()).toBe(true) })
    } finally { act(cancelDraftShutdown) }
})
