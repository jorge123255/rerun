import { afterEach, expect, test, vi } from 'vitest'
import { exportInput, importInspection, shareManifest, sharePlan, shareReview } from '@/components/desktop/coworker-share/test-fixtures'
import { createDesktopCoworkerShareClient } from './client'

afterEach(() => vi.unstubAllGlobals())

function response(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

test('receiver inspection is a read-only opt-in query and keeps counts bound to its manifest', async () => {
    const inspected = importInspection(shareManifest,{ status: 'verified',contents: { count: 2,bytes: 540 },viewCount: 3,digest: '1'.repeat(64) })
    const fetcher = vi.fn().mockResolvedValueOnce(response(inspected)).mockResolvedValueOnce(response({ manifest: shareManifest }))
    vi.stubGlobal('fetch',fetcher)
    const client = createDesktopCoworkerShareClient({ workspaceId: 2,routeAgentId: 'portable-import' })
    expect(await client.inspect(shareManifest.packageKey)).toEqual(inspected)
    const [url,init] = fetcher.mock.calls[0]!
    expect(String(url)).toContain('preview=1'); expect(String(url)).toContain('inspection=1')
    expect(init).toMatchObject({ method: 'GET',cache: 'no-store' }); expect(init?.body).toBeUndefined()
    expect((await client.inspect(shareManifest.packageKey)).importReview.database).toEqual({ status: 'unavailable' })
    expect(fetcher).toHaveBeenCalledTimes(2)
    client.dispose()
})

test('plan, review and export use E’s exact scoped operations and reviewed digest', async () => {
    const fetcher = vi.fn()
        .mockResolvedValueOnce(response({ plan: sharePlan }))
        .mockResolvedValueOnce(response(shareReview))
        .mockResolvedValueOnce(response({ manifest: shareReview.manifest,archiveSha256: shareReview.archiveSha256,archiveBytes: shareReview.archiveBytes,reused: true }))
    vi.stubGlobal('fetch', fetcher)
    const client = createDesktopCoworkerShareClient({ workspaceId: 1, routeAgentId: 'agent-a' })
    await client.plan()
    await client.review({ sourceRevision: exportInput.sourceRevision, requestId: exportInput.requestId, include: exportInput.include })
    await client.export(exportInput)
    for (const [index, action] of ['plan', 'review', 'export'].entries()) {
        const [url, init] = fetcher.mock.calls[index]!
        expect(url).toBe('/api/desktop/coworkers/agent-a/share')
        expect(JSON.parse(String(init?.body))).toMatchObject({ action, workspaceId: 1, agentId: 'agent-a' })
    }
    expect(JSON.parse(String(fetcher.mock.calls[2]![1]?.body))).toMatchObject({ reviewId: exportInput.reviewId, expectedDigest: exportInput.expectedDigest })
    client.dispose()
})

test('preview is observational, download is explicit and import recovery retains request identity', async () => {
    const fetcher = vi.fn()
        .mockResolvedValueOnce(response({ manifest: shareManifest }))
        .mockImplementation(async () => response({ status: 'imported', importedAgentId: 'fresh-a' }))
    vi.stubGlobal('fetch', fetcher)
    const client = createDesktopCoworkerShareClient({ workspaceId: 1, routeAgentId: 'agent-a' })
    expect(await client.preview(shareManifest.packageKey)).toEqual(shareManifest)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(client.downloadUrl(shareManifest.packageKey)).toContain(`snapshotId=${shareManifest.packageKey}`)
    expect(fetcher).toHaveBeenCalledOnce()
    const input = { requestId: '66666666-6666-4666-8666-666666666666', snapshotId: shareManifest.packageKey, expectedDigest: shareManifest.contentDigest, targetWorkspaceId: 2 }
    expect(await client.import(input)).toEqual({ status: 'imported', importedAgentId: 'fresh-a' })
    expect(await client.import(input)).toEqual({ status: 'imported', importedAgentId: 'fresh-a' })
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]?.body))).toEqual({ action: 'import', ...input })
    expect(JSON.parse(String(fetcher.mock.calls[2]![1]?.body))).toEqual({ action: 'import', ...input })
    client.dispose()
})

test('partial, unavailable and reused import responses are not a fresh copy', async () => {
    const input = { requestId: '66666666-6666-4666-8666-666666666666', snapshotId: shareManifest.packageKey, expectedDigest: shareManifest.contentDigest, targetWorkspaceId: 2 }
    vi.stubGlobal('fetch', vi.fn()
        .mockResolvedValueOnce(response({ status: 'partial', reason: 'Two tables were not installed.' }))
        .mockResolvedValueOnce(response({ status: 'unavailable', reason: 'Install writer is not bound.' }))
        .mockResolvedValueOnce(response({ status: 'reused', importedAgentId: 'fresh-a' })))
    const client = createDesktopCoworkerShareClient({ workspaceId: 1, routeAgentId: 'agent-a' })
    await expect(client.import(input)).rejects.toMatchObject({ message: 'Two tables were not installed.', definite: true })
    await expect(client.import(input)).rejects.toMatchObject({ message: 'Install writer is not bound.', definite: true })
    await expect(client.import(input)).rejects.toMatchObject({ message: 'The destination did not install a fresh copy. Retry this same attempt.', definite: true })
    client.dispose()
})

test('a stale review is definite while an interrupted acknowledgement is recoverable', async () => {
    vi.stubGlobal('fetch', vi.fn()
        .mockResolvedValueOnce(response({ error: 'The coworker changed.' }, 409))
        .mockRejectedValueOnce(new TypeError('offline')))
    const client = createDesktopCoworkerShareClient({ workspaceId: 1, routeAgentId: 'agent-a' })
    await expect(client.plan()).rejects.toMatchObject({ definite: true })
    await expect(client.plan()).rejects.toMatchObject({ definite: false })
    client.dispose()
})
