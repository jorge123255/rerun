// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { DESKTOP_DOCUMENT_MAX_BYTES, DESKTOP_DOCUMENT_STAGED_MAX_BYTES, DESKTOP_DOCUMENT_STAGED_UPLOAD_HEADER, FOREMAN_AGENT_ID, type DesktopDocumentAttachment } from '@rerun/contracts'
import { uploadDesktopDocument } from './client'

const scope = { agentId: 'owner', tabUid: 'tab', sessionId: 'session' }
const id = '11111111-1111-4111-8111-111111111111'
/** A File of a given size that holds no bytes: nothing here may read it. */
const sized = (name: string, size: number, type = '') => {
    const file = new File([], name, { type })
    Object.defineProperty(file, 'size', { value: size })
    Object.defineProperty(file, 'arrayBuffer', { value: () => { throw new Error('a large file must not be read into memory') } })
    return file
}
const saved = (file: File): DesktopDocumentAttachment => ({ attachmentId: id, scope, name: file.name, kind: 'binary', mimeType: 'application/octet-stream', byteLength: file.size, sha256: 'a'.repeat(64),
    conversion: { mode: 'staged-file', state: 'ready', stagedRef: `chat-uploads/11111111-111141-${file.name}` }, admitted: false, selected: true, uploaded: true, position: 3, revision: id, createdAt: 'now', updatedAt: 'now' })

class FakeRequest {
    static last: FakeRequest
    method = ''; url = ''; headers: Record<string, string> = {}; body: unknown; status = 0; responseText = ''; responseType = ''; timeout = 0; aborted = false
    upload: { onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null }
    onload: (() => void) | null = null; onerror: (() => void) | null = null; ontimeout: (() => void) | null = null; onabort: (() => void) | null = null
    constructor() { FakeRequest.last = this }
    open(method: string, url: string) { this.method = method; this.url = url }
    setRequestHeader(name: string, value: string) { this.headers[name] = value }
    send(body: unknown) { this.body = body }
    abort() { this.aborted = true; this.onabort?.() }
    reply(status: number, body: unknown) { this.status = status; this.responseText = JSON.stringify(body); this.onload?.() }
}
afterEach(() => { vi.unstubAllGlobals() })

it('sends a large file as the request body itself, with its description in one header, and reports progress', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeRequest)
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    const file = sized('données 2026.zip', DESKTOP_DOCUMENT_MAX_BYTES + 1, 'application/zip'), progress: number[] = []
    const pending = uploadDesktopDocument(scope, id, file, undefined, 3, value => progress.push(value))
    await Promise.resolve()
    const request = FakeRequest.last
    expect([request.method, request.url]).toEqual(['POST', '/api/desktop/coworkers/owner/document-attachments/staged'])
    // The File object, not a copy, a string or a form: the browser streams it from disk.
    expect(request.body).toBe(file)
    expect(request.headers['content-type']).toBe('application/octet-stream')
    expect(JSON.parse(decodeURIComponent(request.headers[DESKTOP_DOCUMENT_STAGED_UPLOAD_HEADER]!))).toEqual({ ...scope, attachmentId: id, name: 'données 2026.zip', mimeType: 'application/zip', position: 3, byteLength: file.size })
    expect(request.headers[DESKTOP_DOCUMENT_STAGED_UPLOAD_HEADER]).toMatch(/^[\x21-\x7e]+$/)
    expect(request.timeout).toBe(120_000)
    request.upload.onprogress!({ lengthComputable: true, loaded: file.size / 4, total: file.size })
    request.upload.onprogress!({ lengthComputable: false, loaded: 1, total: 0 })
    request.upload.onprogress!({ lengthComputable: true, loaded: file.size, total: file.size })
    expect(progress).toEqual([0.25, 1])
    request.reply(200, { attachment: saved(file) })
    expect(await pending).toMatchObject({ attachmentId: id, uploaded: true, byteLength: file.size })
    expect(fetch).not.toHaveBeenCalled()
})

it('reports the server’s reason, a dropped connection and a cancellation', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeRequest)
    const file = sized('backup.zip', 20 * 1024 * 1024)
    const refused = uploadDesktopDocument(scope, id, file); await Promise.resolve()
    FakeRequest.last.reply(413, { error: 'Files larger than 16 MB can be up to 200 MB in total in one message.' })
    await expect(refused).rejects.toThrow('200 MB in total')
    const dropped = uploadDesktopDocument(scope, id, file); await Promise.resolve()
    FakeRequest.last.onerror!()
    await expect(dropped).rejects.toThrow('did not finish')
    const controller = new AbortController(), cancelled = uploadDesktopDocument(scope, id, file, controller.signal); await Promise.resolve()
    controller.abort(new Error('stopped'))
    await expect(cancelled).rejects.toThrow('stopped')
    expect(FakeRequest.last.aborted).toBe(true)
    // Another conversation's attachment in the reply is not accepted as this upload's.
    const foreign = uploadDesktopDocument(scope, id, file); await Promise.resolve()
    FakeRequest.last.reply(200, { attachment: { ...saved(file), scope: { ...scope, tabUid: 'other' } } })
    await expect(foreign).rejects.toThrow('another conversation')
})

it('refuses a file over its limit before any request, naming the limit', async () => {
    vi.stubGlobal('XMLHttpRequest', class { constructor() { throw new Error('no request expected') } })
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('no request expected') }))
    await expect(uploadDesktopDocument(scope, id, sized('huge.zip', DESKTOP_DOCUMENT_STAGED_MAX_BYTES + 1))).rejects.toThrow('up to 100 MB')
    await expect(uploadDesktopDocument(scope, id, sized('scan.pdf', DESKTOP_DOCUMENT_MAX_BYTES + 1))).rejects.toThrow('up to 16 MB')
    await expect(uploadDesktopDocument({ ...scope, agentId: FOREMAN_AGENT_ID }, id, sized('backup.zip', DESKTOP_DOCUMENT_MAX_BYTES + 1))).rejects.toThrow('up to 16 MB')
    await expect(uploadDesktopDocument(scope, id, sized('empty.zip', 0))).rejects.toThrow('non-empty')
})

it('keeps the one-request path for a file within the document limit', async () => {
    vi.stubGlobal('XMLHttpRequest', class { constructor() { throw new Error('a small file must not be streamed') } })
    const file = new File(['PK\u0003\u0004'], 'small.zip', { type: 'application/zip' })
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
        expect(JSON.parse(String(init.body))).toMatchObject({ operation: 'upload', attachmentId: id, name: 'small.zip', audioBase64: btoa('PK\u0003\u0004') })
        return new Response(JSON.stringify({ attachment: { ...saved(file), position: 0 } }))
    })
    vi.stubGlobal('fetch', fetch)
    expect(await uploadDesktopDocument(scope, id, file)).toMatchObject({ name: 'small.zip', uploaded: true })
    expect(String(fetch.mock.calls[0]![0])).toBe('/api/desktop/coworkers/owner/document-attachments')
})
