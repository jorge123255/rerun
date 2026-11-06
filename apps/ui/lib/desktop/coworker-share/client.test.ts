import { afterEach, expect, test, vi } from 'vitest'
import { exportInput, shareManifest, sharePlan, shareReview } from '@/components/desktop/coworker-share/test-fixtures'
import { createDesktopCoworkerShareClient } from './client'

afterEach(() => vi.unstubAllGlobals())

function response(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

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

test('a stale review is definite while an interrupted acknowledgement is recoverable', async () => {
    vi.stubGlobal('fetch', vi.fn()
        .mockResolvedValueOnce(response({ error: 'The coworker changed.' }, 409))
        .mockRejectedValueOnce(new TypeError('offline')))
    const client = createDesktopCoworkerShareClient({ workspaceId: 1, routeAgentId: 'agent-a' })
    await expect(client.plan()).rejects.toMatchObject({ definite: true })
    await expect(client.plan()).rejects.toMatchObject({ definite: false })
    client.dispose()
})
