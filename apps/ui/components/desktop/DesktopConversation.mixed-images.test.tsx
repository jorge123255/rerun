// @vitest-environment happy-dom
import { desktopNativeReviewRead } from '@/test/desktop-background-fixture'
import { act, StrictMode, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { desktopAttachmentFieldsOf, desktopAttachmentSelectionsOf, type DesktopAttachmentFields, type DesktopImageSnapshot } from '@rerun/contracts'
import { cancelDraftShutdown, flushDesktopDrafts, forgetCoworkerDrafts } from '@/lib/desktop/draft-writes'
import { DesktopConversation } from './DesktopConversation'

const chat = vi.hoisted(() => ({ messages: [], status: 'ready', error: undefined,
    sendMessage: vi.fn(), stop: vi.fn(), setMessages: vi.fn(), clearError: vi.fn(), regenerate: vi.fn() }))
vi.mock('@ai-sdk/react', () => ({ useChat: () => chat }))
vi.mock('./DesktopModelSelector', () => ({ DesktopModelSelector: ({ onReady }: { onReady?: (ready: boolean) => void }) => {
    useEffect(() => onReady?.(true), [onReady]); return null
} }))
vi.mock('./DesktopCoworkerNotificationBell', () => ({ DesktopCoworkerNotificationControl: () => null }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root, container: HTMLDivElement
let agent: { id: string; name: string; description: string; createdAt: string; updatedAt: string }
let imports: string[]
let importFile: (name: string, image: boolean, signal?: AbortSignal | null) => Promise<Response>
let stored: DesktopAttachmentFields & { revision: number; text: string }
let attempts: { id: string; name: string; size: number }[]
const pngBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])
const imageOf = (name = 'picture.png'): DesktopImageSnapshot => ({ sha256: '1'.repeat(64), name, path: name, mediaType: 'image/png', width: 1, height: 1, byteLength: pngBytes.length })
const txt = (name: string) => new File(['text'], name, { type: 'text/plain' })
const png = (name = 'picture.png') => new File([pngBytes], name, { type: 'image/png' })
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
const render = (session = 'saved', tabUid?: string) => act(async () => {
    root.render(<StrictMode><DesktopConversation agent={agent} sessionId={session} tabUid={tabUid} sessions={[]}
        onSelectSession={() => {}} onChatSession={() => {}} /></StrictMode>)
})
const composer = () => container.querySelector('textarea')!
const type = (value: string) => act(async () => {
    const input = composer()
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
})
const submit = () => act(async () => { composer().form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
const pick = (files: File[]) => act(async () => {
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Upload files from this Mac"]')!
    Object.defineProperty(input, 'files', { value: files, configurable: true })
    input.dispatchEvent(new Event('change', { bubbles: true }))
})
async function drain() { for (let i = 0; i < 8; i++) await flush() }
const success = (name: string, image: boolean) => Response.json({ path: name, name, ...(image && { image: imageOf(name) }) }, { status: 201 })

beforeEach(() => {
    cancelDraftShutdown()
    agent = { id: `mixed-${crypto.randomUUID()}`, name: 'Mixed reader', description: '', createdAt: '', updatedAt: '' }
    imports = []; attempts = []; stored = { revision: 0, text: '' }
    importFile = async (name, image) => success(name, image)
    chat.messages = []; chat.status = 'ready'; chat.error = undefined
    chat.sendMessage.mockReset().mockResolvedValue(undefined)
    chat.setMessages.mockClear()
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 1, height: 1, close() {} })))
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const nativeReview = desktopNativeReviewRead(input, init); if (nativeReview) return nativeReview
        const url = new URL(String(input), 'http://local'), method = init?.method ?? 'GET'
        if (url.pathname.endsWith('/upload-attempts')) {
            if (method === 'GET') return Response.json({ attempts })
            const body = JSON.parse(String(init?.body))
            if (method === 'DELETE') { attempts = attempts.filter(item => item.id !== body.id); return Response.json({ dismissed: true }) }
            const attempt = { id: body.id, name: body.name, size: body.size }
            attempts.push(attempt)
            return Response.json({ created: true, attempt })
        }
        if (url.pathname.endsWith('/draft')) {
            if (method === 'GET') return Response.json({ draft: stored })
            const body = JSON.parse(String(init?.body))
            if (method === 'PUT') {
                if (body.baseRevision !== stored.revision) return Response.json({ error: 'Changed draft', draft: stored }, { status: 409 })
                stored = { revision: stored.revision + 1, text: body.text, ...desktopAttachmentFieldsOf(desktopAttachmentSelectionsOf(body)) }
            }
            return Response.json({ draft: stored })
        }
        if ((url.pathname.endsWith('/images') || url.pathname.endsWith('/files')) && method === 'POST') {
            const file = (init!.body as FormData).get('file') as File
            imports.push(file.name)
            return importFile(file.name, url.pathname.endsWith('/images'), init?.signal)
        }
        if (url.pathname.endsWith('/files')) return Response.json({ entries: ['one.txt', 'two.md', 'notes.txt', 'legacy.txt'].map(name => ({ name, type: 'file', size: 4 })) })
        if (url.pathname.endsWith('/questions')) return Response.json({ question: null })
        if (url.pathname.endsWith('/takeover')) return Response.json({ takeover: null })
        if (url.pathname.endsWith('/approvals')) return Response.json({ approval: null })
        if (url.pathname.endsWith('/queue')) return Response.json({ queued: null })
        if (url.pathname.endsWith('/messages')) return Response.json({ messages: [] })
        if (url.pathname.endsWith('/skills/suggestions')) return Response.json({ skills: [] })
        return Response.json({ running: false })
    }))
    container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
    await act(async () => { root.unmount() })
    forgetCoworkerDrafts(agent.id); cancelDraftShutdown(); container.remove(); vi.unstubAllGlobals()
})

test.each(['Use all three', ''])('StrictMode imports mixed attachments once and Enter waits for all uploads (text=%j)', async text => {
    let release!: () => void
    importFile = (name, image) => name === 'one.txt'
        ? new Promise(resolve => { release = () => resolve(success(name, image)) })
        : Promise.resolve(success(name, image))
    await render(); await drain()
    await pick([txt('one.txt'), png(), txt('two.md')]); await flush()
    expect(imports).toEqual(['one.txt'])
    await type(text); await submit()
    expect(chat.sendMessage).not.toHaveBeenCalled()
    await act(async () => { release() }); await drain()
    expect(imports).toEqual(['one.txt', 'picture.png', 'two.md'])
    expect(chat.sendMessage).toHaveBeenCalledOnce()
    expect(chat.sendMessage.mock.calls[0]?.[1]).toEqual({ body: { agentId: agent.id, sessionId: 'saved', attachmentItems: [
        { type: 'text', path: 'one.txt' }, { type: 'image', image: imageOf() }, { type: 'text', path: 'two.md' },
    ] } })
})

test('a refused later image cancels an Enter intent rather than sending the accepted subset', async () => {
    let release!: () => void
    importFile = (name, image) => name === 'one.txt'
        ? new Promise(resolve => { release = () => resolve(success(name, image)) })
        : Promise.resolve(success(name, image))
    await render(); await drain()
    await pick([txt('one.txt'), new File(['not an image'], 'bad.png'), txt('two.md')]); await flush()
    await type('Keep this until I review the failed attachment'); await submit()
    await act(async () => { release() }); await drain()
    expect(imports).toEqual(['one.txt', 'two.md'])
    expect(chat.sendMessage).not.toHaveBeenCalled()
    expect(composer().value).toBe('Keep this until I review the failed attachment')
    expect([...container.querySelectorAll('[role="alert"]')].map(node => node.textContent).join(' ')).toContain('bad.png')
})

test('switching chats during an image import cancels remaining files and the old send intent', async () => {
    let release!: () => void, signal: AbortSignal | null | undefined
    importFile = (name, image, current) => new Promise(resolve => { signal = current; release = () => resolve(success(name, image)) })
    await render('first'); await drain()
    await pick([png(), txt('two.md')]); await flush()
    await type('Old chat message'); await submit()
    await render('second'); await flush()
    expect(signal?.aborted).toBe(true)
    await act(async () => { release() }); await drain()
    expect(imports).toEqual(['picture.png'])
    expect(chat.sendMessage).not.toHaveBeenCalled()
    expect(container.querySelector('img[alt="picture.png"]')).toBeNull()
})

test('Quit releases the mixed drain and cannot start the next import or send', async () => {
    let signal: AbortSignal | null | undefined
    importFile = (_name, _image, current) => { signal = current; return new Promise<Response>(() => {}) }
    await render(); await drain()
    await pick([png(), txt('two.md')]); await flush()
    await type('Do not send during Quit'); await submit()
    let quitting!: Promise<boolean>
    await act(async () => { quitting = flushDesktopDrafts() })
    await drain()
    expect(await quitting).toBe(true)
    expect(signal?.aborted).toBe(true)
    expect(imports).toEqual(['picture.png'])
    expect(chat.sendMessage).not.toHaveBeenCalled()
})

test('mixed saved attachments hydrate as original chips and keep their order after remount', async () => {
    stored = { revision: 7, text: 'Saved mixed draft', attachmentItems: [
        { type: 'image', image: imageOf() }, { type: 'text', path: 'notes.txt' },
    ] }
    await render('saved', 'mixed-tab'); await drain()
    expect(composer().value).toBe('Saved mixed draft')
    expect(container.querySelector('img[alt="picture.png"]')?.getAttribute('src')).toContain('/images?snapshot=')
    expect(container.querySelector('span[title="notes.txt"]')).not.toBeNull()
    await type('Saved mixed draft, edited'); await drain()
    expect(stored.attachmentItems).toEqual([{ type: 'image', image: imageOf() }, { type: 'text', path: 'notes.txt' }])
    await act(async () => { root.unmount() }); forgetCoworkerDrafts(agent.id); root = createRoot(container)
    await render('saved', 'mixed-tab'); await drain()
    expect(composer().value).toBe('Saved mixed draft, edited')
    await submit(); await drain()
    expect(chat.sendMessage.mock.calls[0]?.[1]?.body.attachmentItems).toEqual([{ type: 'image', image: imageOf() }, { type: 'text', path: 'notes.txt' }])
})

test('legacy text-only saved drafts retain the legacy single-path request shape', async () => {
    stored = { revision: 2, text: 'Legacy saved draft', attachmentPath: 'legacy.txt' }
    await render('saved', 'legacy-tab'); await drain(); await submit(); await drain()
    expect(chat.sendMessage.mock.calls[0]?.[1]).toEqual({ body: { agentId: agent.id, sessionId: 'saved', attachmentPath: 'legacy.txt' } })
})

test('mixed unfinished statuses hydrate independently without losing either family', async () => {
    attempts = [
        { id: crypto.randomUUID(), name: 'unconfirmed.txt', size: 40 },
        { id: crypto.randomUUID(), name: 'unconfirmed.png', size: 4 * 1024 * 1024 },
    ]
    stored = { revision: 0, text: 'Wait for review' }
    await render('saved', 'statuses-tab'); await drain()
    expect(container.textContent).toContain('unconfirmed.txt')
    expect(container.textContent).toContain('unconfirmed.png')
    expect(container.textContent).not.toContain('Could not check unfinished imports')
    await submit(); await drain()
    expect(chat.sendMessage).not.toHaveBeenCalled()
    expect(imports).toEqual([])
})

test('a selection above the combined limit imports nothing and leaves a clear notice', async () => {
    await render(); await drain()
    await pick(Array.from({ length: 15 }, (_, i) => txt(`file-${i}.txt`))); await drain()
    expect(imports).toEqual([])
    expect(container.textContent).toContain('Choose up to 10 text files and 4 images')
    expect(chat.sendMessage).not.toHaveBeenCalled()
})


test('an attachment-only saved draft can send after reopening, while an empty composer cannot', async () => {
    await render('saved', 'files-only'); await drain()
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true)
    await submit(); await drain()
    expect(chat.sendMessage).not.toHaveBeenCalled()
    await pick([png(), txt('notes.txt')]); await drain()
    await act(async () => { root.unmount() }); forgetCoworkerDrafts(agent.id); root = createRoot(container)
    await render('saved', 'files-only'); await drain()
    expect(composer().value).toBe('')
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false)
    await submit(); await drain()
    expect(chat.sendMessage).toHaveBeenCalledOnce()
    expect(chat.sendMessage.mock.calls[0]?.[0]).toEqual({ text: '', metadata: { attachmentItems: [
        { type: 'image', image: imageOf() }, { type: 'text', path: 'notes.txt' },
    ] } })
})
