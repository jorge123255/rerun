import { expect, test } from 'vitest'
import { desktopResultFileDisposition, desktopResultFileName, desktopResultFileOptionalText, desktopResultFilePreviewKind, desktopResultFileRoute, parseDesktopResultFileBody } from './contract'
import { bindDesktopResultFileRead, desktopResultFileResponse, handleDesktopResultFilePost, unboundDesktopResultFileResponse, type DesktopResultFileRead } from './handler'
import type { DesktopRuntime } from '../runtime'

const ticket = { agentId: 'coworker-1', path: 'reports/bundle.zip', name: 'bundle.zip', scope: 'agent' as const, identity: '7:8', size: 4 }
const bytes = new Uint8Array([1, 2, 3, 4])
const read = (over: Partial<DesktopResultFileRead> = {}): DesktopResultFileRead => ({ bytes, identity: '7:8', size: 4, ...over })

test('rejects a client filename, an absolute path, a private preview and an unsafe name', () => {
    expect(parseDesktopResultFileBody('coworker-1', { ...ticket, filename: 'evil.zip' })).toBeUndefined()
    expect(parseDesktopResultFileBody('coworker-1', { path: '/tmp/bundle.zip', scope: 'shared', identity: '7:8', size: 4 })).toBeUndefined()
    expect(parseDesktopResultFileBody('coworker-1', { path: 'reports/deck.pdf', scope: 'agent', identity: '7:8', size: 4 })).toBeUndefined()
    expect(parseDesktopResultFileBody('coworker-1', { path: 'reports/a"b.zip', scope: 'agent', identity: '7:8', size: 4 })?.name).toBe('a"b.zip')
    expect(desktopResultFileName('a"b.zip')).toBe('a"b.zip')
    expect(desktopResultFileName('a;b.zip')).toBe('a;b.zip')
    expect(parseDesktopResultFileBody('coworker-1', { path: 'reports/bundle.zip', scope: 'agent', identity: '7:8', size: 4 })).toMatchObject(ticket)
    expect(parseDesktopResultFileBody('coworker-1', { path: 'notes/page.pdf', scope: 'shared', identity: '7:8', size: 4 })?.scope).toBe('shared')
    expect(desktopResultFileRoute('coworker 1')).toBe('/api/desktop/coworkers/coworker%201/result-files')
    expect(desktopResultFileRoute('coworker 1')).not.toContain('http')
})

test('a missing, changed or unnamed file is not a download', async () => {
    const missing = desktopResultFileResponse(ticket, null)
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: 'This file is no longer available.', downloaded: false })
    const changed = desktopResultFileResponse(ticket, read({ identity: '1:1' }))
    expect(changed.status).toBe(409)
    expect(await changed.json()).toMatchObject({ downloaded: false })
    expect(desktopResultFileResponse(ticket, read({ size: 3, bytes: new Uint8Array([1, 2, 3]) })).status).toBe(409)
    expect(desktopResultFileDisposition('a"b.zip')).toContain('filename*=UTF-8\'\'a%22b.zip')
})

test('returns the saved name and identity with the verified bytes', () => {
    const response = desktopResultFileResponse(ticket, read())
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/octet-stream')
    expect(response.headers.get('content-length')).toBe('4')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-rerun-result-identity')).toBe('7:8')
    expect(response.headers.get('content-disposition')).toBe(`attachment; filename="bundle.zip"; filename*=UTF-8''bundle.zip`)
})

test('an unbound reader fails closed before any file is opened', async () => {
    bindDesktopResultFileRead(undefined)
    expect(unboundDesktopResultFileResponse().status).toBe(503)
    const runtime = { dataRoot: '/result-file-test-must-not-be-opened' } as DesktopRuntime
    const request = new Request('http://127.0.0.1/result-files', { method: 'POST', body: JSON.stringify(ticket) })
    const response = await handleDesktopResultFilePost(runtime, 'coworker-1', request)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'Result file downloads are not available.', downloaded: false })
})

test('the actual route reader rejects an oversized body before database or file access', async () => {
    const read = async () => { throw new Error('Must not read') }
    const request = new Request('http://127.0.0.1/result-files', { method: 'POST', body: JSON.stringify({ path: 'x'.repeat(13_000) }) })
    await expect(handleDesktopResultFilePost({ dataRoot: '/must-not-open' } as DesktopRuntime, 'owner', request, { read })).rejects.toMatchObject({ status: 413 })
})

test('source, data and config download tiles get an optional bounded text preview in either scope', () => {
    for (const path of ['out/rows.csv', 'out/data.json', 'run.log', 'src/app.ts', 'site/index.html', 'deploy.yaml', 'q.sql', 'tool.py']) {
        expect(desktopResultFilePreviewKind({ path, scope: 'agent', size: 10 })).toBe('text')
        expect(desktopResultFilePreviewKind({ path, scope: 'shared', size: 10 })).toBe('text')
        expect(desktopResultFileOptionalText({ path, size: 10 })).toBe(true)
        // The ticket is still an ordinary 16 MB download tile, not a private preview type.
        expect(parseDesktopResultFileBody('coworker-1', { path, scope: 'agent', identity: '7:8', size: 10 })?.path).toBe(path)
        expect(desktopResultFilePreviewKind({ path, scope: 'agent', size: 256 * 1024 + 1 })).toBe('none')
        expect(desktopResultFilePreviewKind({ path, scope: 'agent' })).toBe('none')
        expect(desktopResultFilePreviewKind({ path, scope: 'agent', size: 0 })).toBe('none')
    }
    for (const path of ['bundle.zip', 'deck.pptx', 'sheet.xlsx', 'tool.exe', 'noext']) {
        expect(desktopResultFilePreviewKind({ path, scope: 'agent', size: 10 })).toBe('none')
        expect(desktopResultFilePreviewKind({ path, scope: 'shared', size: 10 })).toBe('none')
    }
    // The strict .txt/.md preview is not optional, and private media never previews through this route.
    expect(desktopResultFileOptionalText({ path: 'notes.md', size: 10 })).toBe(false)
    expect(desktopResultFilePreviewKind({ path: 'notes.md', scope: 'shared', size: 10 })).toBe('text')
    expect(desktopResultFilePreviewKind({ path: 'notes.md', scope: 'agent', size: 10 })).toBe('none')
    expect(desktopResultFilePreviewKind({ path: 'a.png', scope: 'agent', size: 10 })).toBe('none')
})
