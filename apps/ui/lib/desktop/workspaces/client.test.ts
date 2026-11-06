// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { createDesktopWorkspaceClient } from './client'
const requestId = '00000000-0000-4000-8000-000000000001'
const workspace = { workspaceId: 2, name: 'Second', iconCatalogId: null, directoryName: '2', pathStatus: 'ready', createdAt: '2026-11-06T00:00:00.000Z', updatedAt: '2026-11-06T00:00:00.000Z' }
const setBridge = (bridge: unknown) => { (window as Window & { desktopApp?: unknown }).desktopApp = { workspaces: bridge } }
afterEach(() => { delete (window as Window & { desktopApp?: unknown }).desktopApp; vi.unstubAllGlobals() })
it('uses native create and validates its acknowledgement without a fallback HTTP effect', async () => {
    const create = vi.fn(async () => ({ ok: true, workspace, switched: false })), fetch = vi.fn()
    setBridge({ create }); vi.stubGlobal('fetch', fetch)
    const client = createDesktopWorkspaceClient()
    expect(client.native).toBe(true)
    expect(await client.create({ requestId, name: 'Second', iconCatalogId: null })).toMatchObject({ ok: true, workspace })
    expect(create).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled()
    create.mockResolvedValueOnce({ ok: true, workspace: { ...workspace, workspaceId: -1 }, switched: false })
    await expect(client.create({ requestId, name: 'Second', iconCatalogId: null })).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
})
it('refuses a native switch acknowledgement for another request or destination', async () => {
    setBridge({ switchTo: async () => ({ ok: true, workspace, receipt: { version: 1, receiptId: '00000000-0000-4000-8000-000000000002', requestId, fromWorkspaceId: 1, toWorkspaceId: 2, phase: 'published', installId: '00000000-0000-4000-8000-000000000003', createdAt: workspace.createdAt, updatedAt: workspace.updatedAt, reason: null, admissionsFrozen: true, oldRuntimeClosed: true } }) })
    await expect(createDesktopWorkspaceClient().switchTo({ requestId, workspaceId: 3 })).rejects.toThrow('acknowledgement changed')
})
it('does not attempt a production HTTP workspace switch when the native bridge is unavailable', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    await expect(createDesktopWorkspaceClient().switchTo({ requestId, workspaceId: 2 })).rejects.toThrow('Mac app')
    expect(fetch).not.toHaveBeenCalled()
})
