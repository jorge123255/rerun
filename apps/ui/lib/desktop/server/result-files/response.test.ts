import { expect, test } from 'vitest'
import { desktopResultFileDisposition, desktopResultFileName, desktopResultFileRoute, parseDesktopResultFileBody } from './contract'
import { bindDesktopResultFileRead, desktopResultFileResponse, handleDesktopResultFilePost, unboundDesktopResultFileResponse, type DesktopResultFileRead } from './handler'
import type { DesktopRuntime } from '../runtime'

const ticket = { agentId: 'coworker-1', path: 'reports/bundle.zip', name: 'bundle.zip', scope: 'agent' as const, identity: '7:8', size: 4 }
const bytes = new Uint8Array([1, 2, 3, 4])
const read = (over: Partial<DesktopResultFileRead> = {}): DesktopResultFileRead => ({ bytes, identity: '7:8', size: 4, ...over })

test('rejects a client filename, an absolute path, a private preview and an unsafe name', () => {
    expect(parseDesktopResultFileBody('coworker-1', { ...ticket, filename: 'evil.zip' })).toBeUndefined()
    expect(parseDesktopResultFileBody('coworker-1', { path: '/tmp/bundle.zip', scope: 'shared', identity: '7:8', size: 4 })).toBeUndefined()
    expect(parseDesktopResultFileBody('coworker-1', { path: 'reports/deck.pdf', scope: 'agent', identity: '7:8', size: 4 })).toBeUndefined()
    expect(parseDesktopResultFileBody('coworker-1', { path: 'reports/a"b.zip', scope: 'agent', identity: '7:8', size: 4 })).toBeUndefined()
    expect(desktopResultFileName('a"b.zip')).toBeUndefined()
    expect(desktopResultFileName('a;b.zip')).toBeUndefined()
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
    expect(desktopResultFileDisposition('a"b.zip')).toBeUndefined()
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
