import { afterEach, expect, it, vi } from 'vitest'
import { createDesktopOpencodeDriver } from './client'

afterEach(() => vi.unstubAllGlobals())

it('uses the authenticated desktop route with exact C actions and no credential headers', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init })
        const action = JSON.parse(String(init?.body)).action
        if (action === 'prepare') return Response.json({ ok: true })
        if (action === 'usage') return Response.json({ windows: [], capturedAt: null, fresh: false })
        return Response.json({ ok: true })
    }))
    const driver = createDesktopOpencodeDriver()
    const signal = new AbortController().signal
    expect(await driver.prepare('oc_sk_test', signal)).toEqual({ ok: true })
    expect(await driver.usage({ workspaceId: 1, connectionId: 'oc-1', requestId: 'usage-1', refresh: false }, signal)).toEqual({ windows: [], capturedAt: null, fresh: false })
    expect(await driver.enable({ workspaceId: 1, connectionId: 'oc-1', enabledModelIds: ['go/deepseek-v4-pro'], defaultModelId: 'go/deepseek-v4-pro', consoleEnabled: false }, signal)).toEqual({ ok: true })
    expect(calls.map(call => call.url)).toEqual(['/api/desktop/opencode', '/api/desktop/opencode', '/api/desktop/opencode'])
    for (const call of calls) {
        expect(call.init).toMatchObject({ method: 'POST', cache: 'no-store', credentials: 'same-origin', redirect: 'error' })
        expect(call.init?.headers).toEqual({ 'content-type': 'application/json' })
    }
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ action: 'prepare', apiKey: 'oc_sk_test' })
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ action: 'usage', workspaceId: 1, connectionId: 'oc-1', requestId: 'usage-1', refresh: false })
})

it('surfaces a refused result instead of presenting success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ status: 'refused', code: 'credential', message: 'Key rejected', sent: false }, { status: 409 })))
    const driver = createDesktopOpencodeDriver()
    await expect(driver.enable({ workspaceId: 1, connectionId: 'oc-1', enabledModelIds: [], defaultModelId: 'go/deepseek-v4-pro', consoleEnabled: false }, new AbortController().signal)).rejects.toThrow('Key rejected')
})
