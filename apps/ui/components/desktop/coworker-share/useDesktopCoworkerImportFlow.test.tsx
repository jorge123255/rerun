// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { createDesktopCoworkerShareAttempts } from '@/lib/desktop/coworker-share/attempts'
import type { DesktopCoworkerShareClient } from '@/lib/desktop/coworker-share/client'
import { shareManifest } from './test-fixtures'
import { useDesktopCoworkerImportFlow } from './useDesktopCoworkerImportFlow'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.replaceChildren() })

async function mount(overrides: Partial<DesktopCoworkerShareClient> = {}, targetWorkspaceId = 2) {
    const api = {
        plan: vi.fn(), review: vi.fn(), export: vi.fn(), preview: vi.fn(async () => shareManifest), downloadUrl: vi.fn(),
        import: vi.fn(async () => ({ status: 'imported' as const, importedAgentId: 'fresh-a' })), revoke: vi.fn(), dispose: vi.fn(), ...overrides,
    } as DesktopCoworkerShareClient
    const attempts = createDesktopCoworkerShareAttempts()
    let flow!: ReturnType<typeof useDesktopCoworkerImportFlow>
    function Probe() {
        flow = useDesktopCoworkerImportFlow({ client: api, attempts, targetWorkspaceId, snapshotId: shareManifest.packageKey })
        return null
    }
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<Probe />))
    return { api, attempts, flow: () => flow }
}

test('explicit preview and Cancel never install a coworker', async () => {
    const mounted = await mount()
    expect(mounted.api.preview).toHaveBeenCalledExactlyOnceWith(shareManifest.packageKey)
    expect(mounted.api.import).not.toHaveBeenCalled()
    await act(async () => mounted.flow().cancel())
    expect(mounted.api.import).not.toHaveBeenCalled()
})

test('lost import acknowledgement recovers the same fresh copy without navigation', async () => {
    const api = { import: vi.fn()
        .mockResolvedValueOnce({ status: 'uncertain' as const, recoverable: true, reason: 'unknown acknowledgement' })
        .mockResolvedValueOnce({ status: 'imported' as const, importedAgentId: 'fresh-a' }) }
    const mounted = await mount(api)
    await act(async () => mounted.flow().setApproved(true))
    await act(async () => { await mounted.flow().importFresh() })
    const pending = mounted.attempts.listImport({ targetWorkspaceId: 2, snapshotId: shareManifest.packageKey })
    expect(pending).toHaveLength(1)
    await act(async () => { await mounted.flow().importFresh() })
    expect(mounted.api.import).toHaveBeenCalledTimes(2)
    expect(vi.mocked(mounted.api.import).mock.calls[0]![0]).toEqual(vi.mocked(mounted.api.import).mock.calls[1]![0])
    expect(mounted.flow().importedAgentId).toBe('fresh-a')
    expect(mounted.attempts.listImport({ targetWorkspaceId: 2, snapshotId: shareManifest.packageKey })).toEqual([])
})

test('another workspace cannot consume the saved import attempt', async () => {
    const first = await mount({ import: vi.fn(async () => ({ status: 'uncertain' as const, recoverable: true, reason: 'unknown' })) })
    await act(async () => first.flow().setApproved(true))
    await act(async () => { await first.flow().importFresh() })
    expect(first.attempts.listImport({ targetWorkspaceId: 3, snapshotId: shareManifest.packageKey })).toEqual([])
    expect(first.attempts.listImport({ targetWorkspaceId: 2, snapshotId: shareManifest.packageKey })).toHaveLength(1)
})
