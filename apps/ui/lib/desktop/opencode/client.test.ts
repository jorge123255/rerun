import { afterEach, expect, it, vi } from 'vitest'
import { DESKTOP_OPENCODE_CONNECTION_ID } from '@rerun/contracts'
import { changeDesktopOpencode, createDesktopOpencodeDriver } from './client'

afterEach(() => vi.unstubAllGlobals())

const scope = { workspaceId: 1, connectionId: DESKTOP_OPENCODE_CONNECTION_ID }
const connection = { ...scope, name: 'OpenCode', revision: '5a0ea2a3-d2f4-412a-abd8-b111d771c75f',
    defaultModelId: 'go/deepseek-v4-pro', enabledModelIds: ['go/deepseek-v4-pro'], consoleEnabled: false }
const signal = new AbortController().signal

it('reads the public connection and sends key changes only to the authenticated same-origin route', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init })
        return Response.json({ connection })
    }))
    const driver = createDesktopOpencodeDriver()
    expect(await driver.prepare('oc_sk_synthetic', signal)).toEqual({ ok: true })
    expect(await driver.prepare('sk-not-opencode', signal)).toMatchObject({ ok: false })
    expect(calls).toHaveLength(0)
    const saved = await driver.snapshot(scope, signal)
    expect(saved).toMatchObject({ connectionRevision: connection.revision, credentialStored: true })
    expect(saved).not.toHaveProperty('apiKey')
    const input = { action: 'key' as const, workspaceId: 1, expectedRevision: connection.revision, apiKey: 'oc_sk_synthetic' }
    expect(await changeDesktopOpencode(input, signal)).toEqual(connection)
    expect(calls.map(call => call.url)).toEqual(['/api/desktop/opencode/settings?workspaceId=1', '/api/desktop/opencode/settings'])
    expect(calls[1]?.init).toMatchObject({ method: 'POST', cache: 'no-store', credentials: 'same-origin', redirect: 'error', headers: { 'content-type': 'application/json' } })
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual(input)
})

it('refuses an unexpected workspace or a stale connection change', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => init?.method === 'POST'
        ? Response.json({ error: 'OpenCode connection changed.' }, { status: 409 })
        : Response.json({ connection: { ...connection, workspaceId: 2 } })))
    const driver = createDesktopOpencodeDriver()
    await expect(driver.snapshot(scope, signal)).rejects.toThrow('connection changed')
    await expect(changeDesktopOpencode({ action: 'rename', workspaceId: 1, expectedRevision: connection.revision, name: 'New name' }, signal)).rejects.toThrow('connection changed')
})
