// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createDesktopCoworkerShareAttempts } from '@/lib/desktop/coworker-share/attempts'
import type { DesktopCoworkerShareClient } from '@/lib/desktop/coworker-share/client'
import { shareManifest } from './test-fixtures'
import { useDesktopCoworkerImportFlow } from './useDesktopCoworkerImportFlow'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
beforeEach(() => vi.stubGlobal('localStorage', undefined))
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.replaceChildren(); vi.unstubAllGlobals() })

async function mount(overrides: Partial<DesktopCoworkerShareClient> = {}, targetWorkspaceId = 2, onImported?: (agentId: string) => void | Promise<void>) {
    const api = {
        plan: vi.fn(), review: vi.fn(), export: vi.fn(), preview: vi.fn(async () => shareManifest), downloadUrl: vi.fn(),
        import: vi.fn(async () => ({ status: 'imported' as const, importedAgentId: 'fresh-a' })), revoke: vi.fn(), dispose: vi.fn(), ...overrides,
    } as DesktopCoworkerShareClient
    const attempts = createDesktopCoworkerShareAttempts()
    let flow!: ReturnType<typeof useDesktopCoworkerImportFlow>
    function Probe() {
        flow = useDesktopCoworkerImportFlow({ client: api, attempts, targetWorkspaceId, snapshotId: shareManifest.packageKey, onImported })
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

test('a destination failure is not an added coworker and a later success does not import twice', async () => {
    const api = { import: vi.fn()
        .mockResolvedValueOnce({ status: 'partial', importedAgentId: 'incomplete-copy', reason: 'Two tables were not installed.' })
        .mockResolvedValueOnce({ status: 'imported', importedAgentId: 'fresh-a' }) } as Partial<DesktopCoworkerShareClient>
    const onImported = vi.fn()
    const mounted = await mount(api, 2, onImported)
    await act(async () => mounted.flow().setApproved(true))
    await act(async () => { await mounted.flow().importFresh() })
    expect(mounted.flow().importedAgentId).toBeNull()
    expect(mounted.flow().error).toBe('Two tables were not installed.')
    expect(onImported).not.toHaveBeenCalled()
    expect(mounted.attempts.listImport({ targetWorkspaceId: 2, snapshotId: shareManifest.packageKey })).toHaveLength(1)
    await act(async () => { await mounted.flow().importFresh() })
    expect(mounted.flow().importedAgentId).toBe('fresh-a')
    expect(onImported).toHaveBeenCalledExactlyOnceWith('fresh-a')
    await act(async () => { await mounted.flow().importFresh() })
    expect(mounted.api.import).toHaveBeenCalledTimes(2)
    expect(onImported).toHaveBeenCalledTimes(1)
})

test('a changed portable file keeps the saved attempt', async () => {
    const mounted = await mount()
    const saved = { requestId: '66666666-6666-4666-8666-666666666666', snapshotId: shareManifest.packageKey, expectedDigest: '9'.repeat(64), targetWorkspaceId: 2 }
    mounted.attempts.rememberImport(saved)
    await act(async () => mounted.flow().setApproved(true))
    await act(async () => { await mounted.flow().importFresh(saved) })
    expect(mounted.api.import).not.toHaveBeenCalled()
    expect(mounted.flow().error).toContain('The portable file changed')
    expect(mounted.attempts.listImport({ targetWorkspaceId: 2, snapshotId: shareManifest.packageKey })).toEqual([saved])
})

test('another workspace cannot consume the saved import attempt', async () => {
    const first = await mount({ import: vi.fn(async () => ({ status: 'uncertain' as const, recoverable: true as const, reason: 'unknown' })) })
    await act(async () => first.flow().setApproved(true))
    await act(async () => { await first.flow().importFresh() })
    expect(first.attempts.listImport({ targetWorkspaceId: 3, snapshotId: shareManifest.packageKey })).toEqual([])
    expect(first.attempts.listImport({ targetWorkspaceId: 2, snapshotId: shareManifest.packageKey })).toHaveLength(1)
})

test('an exact ACK notifies once per workspace/copy even if recovery-intent cleanup requires the same retry', async () => {
    const onImported = vi.fn()
    const mounted = await mount({},2,onImported)
    vi.spyOn(mounted.attempts,'forgetImport').mockImplementationOnce(() => { throw new Error('Receipt cleanup interrupted') })
    await act(async () => mounted.flow().setApproved(true))
    await act(async () => { await mounted.flow().importFresh() })
    expect(onImported).toHaveBeenCalledExactlyOnceWith('fresh-a')
    await act(async () => { await mounted.flow().importFresh() })
    expect(mounted.api.import).toHaveBeenCalledTimes(2)
    expect(vi.mocked(mounted.api.import).mock.calls[0]![0]).toEqual(vi.mocked(mounted.api.import).mock.calls[1]![0])
    expect(onImported).toHaveBeenCalledTimes(1)
})

test('foreign recovery scope never imports or notifies the current board', async () => {
    const onImported = vi.fn(), mounted = await mount({},2,onImported)
    await act(async () => { await mounted.flow().recoverImport({ requestId: 'foreign-attempt',snapshotId: shareManifest.packageKey,expectedDigest: shareManifest.contentDigest,targetWorkspaceId: 3 }) })
    expect(mounted.api.import).not.toHaveBeenCalled(); expect(onImported).not.toHaveBeenCalled()
    expect(mounted.flow().error).toContain('another workspace')
})

test('an ACK arriving after the import view changes workspace cannot notify the new board', async () => {
    let release!: (value: { status: 'imported'; importedAgentId: string }) => void
    const api = { preview: vi.fn(async () => shareManifest),import: vi.fn(() => new Promise(resolve => { release = resolve })) } as unknown as DesktopCoworkerShareClient
    const attempts = createDesktopCoworkerShareAttempts(), onImported = vi.fn()
    let flow!: ReturnType<typeof useDesktopCoworkerImportFlow>
    function Probe({ workspaceId }: { workspaceId: number }) { flow = useDesktopCoworkerImportFlow({ client: api,attempts,targetWorkspaceId: workspaceId,snapshotId: shareManifest.packageKey,onImported }); return null }
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<Probe workspaceId={2} />))
    await act(async () => flow.setApproved(true))
    let importing!: Promise<boolean>
    await act(async () => { importing = flow.importFresh() })
    await act(async () => root!.render(<Probe workspaceId={3} />))
    await act(async () => { release({ status: 'imported',importedAgentId: 'old-workspace-copy' }); await importing })
    expect(onImported).not.toHaveBeenCalled(); expect(flow.importedAgentId).toBeNull()
})
