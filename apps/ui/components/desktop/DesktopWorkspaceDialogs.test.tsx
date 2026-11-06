// @vitest-environment happy-dom
import { act, StrictMode, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DesktopRemoteActor, DesktopRemoteCommand } from '@rerun/contracts'
import type { DesktopCoworkerShareNavigation } from './coworker-share/DesktopCoworkerShareNavigation'
import type { RemoteMachinesDialog } from './remote-machines/RemoteMachinesDialog'
import { exportInput, shareReview } from './coworker-share/test-fixtures'
import { cancelDraftShutdown, freezeDesktopAdmissions } from '@/lib/desktop/draft-writes'

const mocks = vi.hoisted(() => ({ plan: vi.fn(), dispose: vi.fn(), createClient: vi.fn(), attempts: vi.fn(), share: vi.fn(), remote: vi.fn(), imported: vi.fn(), listWorkspaceImports: vi.fn(), listExport: vi.fn(), listRevocations: vi.fn(), forgetExport: vi.fn(), forgetRevoke: vi.fn(), export: vi.fn(), revoke: vi.fn(), review: vi.fn(), import: vi.fn(), downloadUrl: vi.fn() }))
vi.mock('@/lib/desktop/coworker-share/client', () => ({ createDesktopCoworkerShareClient: mocks.createClient }))
vi.mock('@/lib/desktop/coworker-share/attempts', () => ({ createDesktopCoworkerShareServerAttempts: mocks.attempts }))
vi.mock('./coworker-share/DesktopCoworkerShareNavigation', () => ({ DesktopCoworkerShareNavigation: (props: ComponentProps<typeof DesktopCoworkerShareNavigation>) => {
    mocks.share(props)
    return <button onClick={() => { props.onOpenChange(false); props.onImportSnapshotChange?.('a'.repeat(32)) }}>Preview fresh copy</button>
} }))
vi.mock('./coworker-share/DesktopCoworkerImportDialog', () => ({ DesktopCoworkerImportDialog: (props: unknown) => { mocks.imported(props); return <p>Review portable coworker</p> } }))
vi.mock('./remote-machines/RemoteMachinesDialog', () => ({ RemoteMachinesDialog: (props: ComponentProps<typeof RemoteMachinesDialog>) => { mocks.remote(props); return <p>Native Servers</p> } }))
import { DesktopCoworkerShareLauncher, DesktopPortableCoworkerImport, DesktopServersNavigation, type DesktopWorkspaceNativeTools } from './DesktopWorkspaceDialogs'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const actor: DesktopRemoteActor = { installId: '00000000-0000-4000-8000-000000000001', workspaceId: 2, launchNonce: '00000000-0000-4000-8000-000000000002', rendererEpoch: '00000000-0000-4000-8000-000000000003' }
let root: ReturnType<typeof createRoot>, host: HTMLDivElement
const native = (tools: DesktopWorkspaceNativeTools) => { (window as Window & { desktopApp?: DesktopWorkspaceNativeTools }).desktopApp = tools }
beforeEach(() => {
    vi.clearAllMocks()
    cancelDraftShutdown()
    mocks.listWorkspaceImports.mockResolvedValue([]); mocks.listExport.mockResolvedValue([]); mocks.listRevocations.mockResolvedValue([])
    mocks.forgetExport.mockResolvedValue(undefined); mocks.forgetRevoke.mockResolvedValue(undefined)
    mocks.downloadUrl.mockReturnValue('/download-explicitly')
    mocks.createClient.mockImplementation(() => ({ plan: mocks.plan, dispose: mocks.dispose,export: mocks.export,revoke: mocks.revoke,review: mocks.review,import: mocks.import,downloadUrl: mocks.downloadUrl }))
    mocks.attempts.mockReturnValue({ listWorkspaceImports: mocks.listWorkspaceImports,listExport: mocks.listExport,listRevocations: mocks.listRevocations,forgetExport: mocks.forgetExport,forgetRevoke: mocks.forgetRevoke })
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
    await act(async () => root.unmount())
    document.body.innerHTML = ''
    delete (window as Window & { desktopApp?: DesktopWorkspaceNativeTools }).desktopApp
    cancelDraftShutdown()
})

it('waits for native’s complete actor before opening Servers and delegates exact commands', async () => {
    let release!: (actor: DesktopRemoteActor) => void
    const execute = vi.fn().mockResolvedValue({ ok: false, code: 'authority_missing' })
    native({ remoteMachines: { actor: () => new Promise(resolve => { release = resolve }), execute } })
    await act(async () => root.render(<DesktopServersNavigation workspaceId={2} onClose={() => {}} />))
    expect(mocks.remote).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Opening…')
    await act(async () => { release(actor) })
    const props = mocks.remote.mock.lastCall![0] as ComponentProps<typeof RemoteMachinesDialog>
    expect(props.actor).toEqual(actor)
    const command: DesktopRemoteCommand = { action: 'read', actor, requestId: '00000000-0000-4000-8000-000000000004' }
    await props.bridge!.execute(command, new AbortController().signal)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledWith(command)
})

it('refuses an actor for another runtime workspace without mounting any server client', async () => {
    native({ remoteMachines: { actor: async () => ({ ...actor, workspaceId: 1 }), execute: vi.fn() } })
    await act(async () => root.render(<DesktopServersNavigation workspaceId={2} onClose={() => {}} />))
    expect(mocks.remote).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('selected workspace changed')
})

it('opens Share only with the content revision returned by plan and keeps its own-preview transition active', async () => {
    mocks.plan.mockResolvedValue({ sourceRevision: 'b'.repeat(64) })
    const close = vi.fn()
    await act(async () => root.render(<DesktopCoworkerShareLauncher workspaceId={2} agentId="researcher" agentName="Researcher" onClose={close} onOpenCoworker={() => {}} />))
    expect(mocks.createClient).toHaveBeenCalledWith({ workspaceId: 2, routeAgentId: 'researcher' })
    expect(mocks.share.mock.lastCall![0]).toMatchObject({ workspaceId: 2, sourceRevision: 'b'.repeat(64) })
    await act(async () => { host.querySelector('button')!.click() })
    expect(close).not.toHaveBeenCalled()
    expect(mocks.share.mock.lastCall![0]).toMatchObject({ open: false, importSnapshot: 'a'.repeat(32) })
})

it('does not fabricate a revision when the source plan omits it', async () => {
    mocks.plan.mockResolvedValue({})
    await act(async () => root.render(<DesktopCoworkerShareLauncher workspaceId={2} agentId="researcher" agentName="Researcher" onClose={() => {}} onOpenCoworker={() => {}} />))
    expect(mocks.share).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('revision could not be confirmed')
})

it('uses the portable-import sentinel and the selected runtime workspace after native file selection', async () => {
    native({ coworkerShare: { pickImport: async () => ({ snapshotId: 'c'.repeat(32), fileName: 'Researcher.tar.gz' }) } })
    await act(async () => root.render(<DesktopPortableCoworkerImport workspaceId={2} onClose={() => {}} onOpenCoworker={() => {}} />))
    expect(mocks.createClient).toHaveBeenCalledWith({ workspaceId: 2, routeAgentId: 'portable-import' })
    expect(mocks.attempts).toHaveBeenCalledWith(2, 'portable-import')
    expect(mocks.imported.mock.lastCall![0]).toMatchObject({ targetWorkspaceId: 2, snapshotId: 'c'.repeat(32) })
    expect(mocks.plan).not.toHaveBeenCalled()
})

it('ignores a native picker result after the dialog lifetime ends', async () => {
    let release!: (value: { snapshotId: string; fileName: string }) => void
    native({ coworkerShare: { pickImport: () => new Promise(resolve => { release = resolve }) } })
    const close = vi.fn()
    await act(async () => root.render(<DesktopPortableCoworkerImport workspaceId={2} onClose={close} onOpenCoworker={() => {}} />))
    await act(async () => root.render(null))
    await act(async () => { release({ snapshotId: 'd'.repeat(32), fileName: 'Researcher.tar.gz' }) })
    expect(close).not.toHaveBeenCalled()
    expect(mocks.imported).not.toHaveBeenCalled()
    expect(mocks.dispose).toHaveBeenCalledOnce()
})

it('does not open a second native file picker during StrictMode effect replay', async () => {
    const pickImport = vi.fn().mockResolvedValue({ snapshotId: 'e'.repeat(32), fileName: 'Researcher.tar.gz' })
    native({ coworkerShare: { pickImport } })
    await act(async () => root.render(<StrictMode><DesktopPortableCoworkerImport workspaceId={2} onClose={() => {}} onOpenCoworker={() => {}} /></StrictMode>))
    expect(pickImport).toHaveBeenCalledTimes(1)
    expect(mocks.imported.mock.lastCall![0]).toMatchObject({ targetWorkspaceId: 2, snapshotId: 'e'.repeat(32) })
})

it('restores workspace-two imports before any picker and offers saved archive review without the original external file', async () => {
    const saved = { requestId: 'saved-original-import',snapshotId: 'b'.repeat(32),expectedDigest: 'c'.repeat(64),targetWorkspaceId: 2 }
    mocks.listWorkspaceImports.mockResolvedValue([saved])
    const pickImport = vi.fn().mockRejectedValue(new Error('Original archive was moved'))
    native({ coworkerShare: { pickImport } })
    await act(async () => root.render(<StrictMode><DesktopPortableCoworkerImport workspaceId={2} onClose={() => {}} onOpenCoworker={() => {}} /></StrictMode>))
    expect(mocks.listWorkspaceImports).toHaveBeenCalledWith(2)
    expect(pickImport).not.toHaveBeenCalled(); expect(mocks.import).not.toHaveBeenCalled(); expect(mocks.imported).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Review saved import saved-or')
    const review = [...document.querySelectorAll('button')].find(button => button.textContent?.startsWith('Review saved import'))!
    await act(async () => review.click())
    expect(mocks.imported.mock.lastCall![0]).toMatchObject({ targetWorkspaceId: 2,snapshotId: saved.snapshotId,attempts: mocks.attempts.mock.results[0]!.value })
    expect(pickImport).not.toHaveBeenCalled(); expect(mocks.import).not.toHaveBeenCalled()
})

it('picks another file only after an explicit choice and fences a saved-intent read after quit', async () => {
    const saved = { requestId: 'saved-import',snapshotId: 'b'.repeat(32),expectedDigest: 'c'.repeat(64),targetWorkspaceId: 2 }
    mocks.listWorkspaceImports.mockResolvedValue([saved])
    const pickImport = vi.fn().mockResolvedValue({ snapshotId: 'd'.repeat(32),fileName: 'Another.tar.gz' })
    native({ coworkerShare: { pickImport } })
    await act(async () => root.render(<DesktopPortableCoworkerImport workspaceId={2} onClose={() => {}} onOpenCoworker={() => {}} />))
    expect(pickImport).not.toHaveBeenCalled()
    await act(async () => { [...document.querySelectorAll('button')].find(button => button.textContent === 'Pick another file')!.click() })
    expect(pickImport).toHaveBeenCalledTimes(1)
    expect(mocks.imported.mock.lastCall![0]).toMatchObject({ targetWorkspaceId: 2,snapshotId: 'd'.repeat(32) })
    await act(async () => root.render(null))
    mocks.imported.mockClear(); mocks.listWorkspaceImports.mockImplementation(() => new Promise(() => {}))
    let release!: (value: typeof saved[]) => void
    mocks.listWorkspaceImports.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    await act(async () => root.render(<DesktopPortableCoworkerImport workspaceId={2} onClose={() => {}} onOpenCoworker={() => {}} />))
    freezeDesktopAdmissions()
    await act(async () => { release([saved]) })
    expect(mocks.imported).not.toHaveBeenCalled(); expect(pickImport).toHaveBeenCalledTimes(1)
})

it('refuses a foreign workspace recovery identity before opening any picker or preview', async () => {
    mocks.listWorkspaceImports.mockResolvedValue([{ requestId: 'foreign',snapshotId: 'b'.repeat(32),expectedDigest: 'c'.repeat(64),targetWorkspaceId: 1 }])
    const pickImport = vi.fn(); native({ coworkerShare: { pickImport } })
    await act(async () => root.render(<DesktopPortableCoworkerImport workspaceId={2} onClose={() => {}} onOpenCoworker={() => {}} />))
    expect(document.body.textContent).toContain('another workspace')
    expect(pickImport).not.toHaveBeenCalled(); expect(mocks.imported).not.toHaveBeenCalled()
})

it('a cancelled explicit picker keeps saved recovery available and a fresh explicit choice opens one new picker', async () => {
    mocks.listWorkspaceImports.mockResolvedValue([{ requestId: 'saved-import',snapshotId: 'b'.repeat(32),expectedDigest: 'c'.repeat(64),targetWorkspaceId: 2 }])
    const pickImport = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ snapshotId: 'd'.repeat(32),fileName: 'Another.tar.gz' })
    native({ coworkerShare: { pickImport } })
    const close = vi.fn()
    await act(async () => root.render(<StrictMode><DesktopPortableCoworkerImport workspaceId={2} onClose={close} onOpenCoworker={() => {}} /></StrictMode>))
    const another = () => [...document.querySelectorAll('button')].find(button => button.textContent === 'Pick another file')!
    await act(async () => another().click())
    expect(pickImport).toHaveBeenCalledTimes(1); expect(close).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Review saved import')
    await act(async () => another().click())
    expect(pickImport).toHaveBeenCalledTimes(2)
    expect(mocks.imported.mock.lastCall![0]).toMatchObject({ snapshotId: 'd'.repeat(32),targetWorkspaceId: 2 })
    expect(mocks.import).not.toHaveBeenCalled()
})

it('recovers the exact saved export while the source is unavailable and exposes download only after explicit recovery', async () => {
    const saved = { ...exportInput,workspaceId: 2,agentId: 'researcher' }
    mocks.plan.mockRejectedValue(new Error('Source folder unavailable'))
    mocks.listExport.mockResolvedValue([saved]); mocks.export.mockResolvedValue({ manifest: shareReview.manifest,archiveSha256: shareReview.archiveSha256,archiveBytes: shareReview.archiveBytes,reused: true })
    await act(async () => root.render(<DesktopCoworkerShareLauncher workspaceId={2} agentId="researcher" agentName="Researcher" onClose={() => {}} onOpenCoworker={() => {}} />))
    expect(document.body.textContent).toContain('New share review is disabled')
    expect(mocks.share).not.toHaveBeenCalled(); expect(mocks.export).not.toHaveBeenCalled(); expect(mocks.revoke).not.toHaveBeenCalled()
    expect(document.querySelector('a[download]')).toBeNull()
    await act(async () => { [...document.querySelectorAll('button')].find(button => button.textContent?.startsWith('Recover saved export'))!.click() })
    expect(mocks.export).toHaveBeenCalledTimes(1)
    expect(mocks.export).toHaveBeenCalledWith(saved)
    expect(mocks.forgetExport).toHaveBeenCalledWith(saved)
    expect(document.querySelector('a[download]')?.getAttribute('href')).toBe('/download-explicitly')
    expect(mocks.review).not.toHaveBeenCalled(); expect(mocks.import).not.toHaveBeenCalled()
})

it('withdraws only the original saved request when the source plan fails and retains mismatched receipts for retry', async () => {
    const saved = { requestId: 'original-withdrawal',snapshotId: 'b'.repeat(32),expectedRevision: 'c'.repeat(64) }
    mocks.plan.mockRejectedValue(new Error('Source config unavailable')); mocks.listRevocations.mockResolvedValue([saved])
    mocks.revoke.mockResolvedValueOnce({ operation: 'revoke',status: 'revoked',requestId: 'wrong',snapshotId: saved.snapshotId }).mockResolvedValueOnce({ operation: 'revoke',status: 'revoked',...saved })
    await act(async () => root.render(<DesktopCoworkerShareLauncher workspaceId={2} agentId="researcher" agentName="Researcher" onClose={() => {}} onOpenCoworker={() => {}} />))
    expect(mocks.revoke).not.toHaveBeenCalled()
    const recover = () => [...document.querySelectorAll('button')].find(button => button.textContent?.startsWith('Recover withdrawal'))!
    await act(async () => recover().click())
    expect(mocks.forgetRevoke).not.toHaveBeenCalled(); expect(document.body.textContent).toContain('does not match')
    await act(async () => recover().click())
    expect(mocks.revoke.mock.calls.map(call => call[0])).toEqual([saved,saved])
    expect(mocks.forgetRevoke).toHaveBeenCalledWith({ workspaceId: 2,agentId: 'researcher',snapshotId: saved.snapshotId },saved)
    expect(document.body.textContent).toContain('was withdrawn')
    expect(mocks.export).not.toHaveBeenCalled(); expect(mocks.review).not.toHaveBeenCalled(); expect(mocks.share).not.toHaveBeenCalled()
})

it('does not consume a saved export intent or expose a download after its recovery dialog closes', async () => {
    const saved = { ...exportInput,workspaceId: 2,agentId: 'researcher' }
    mocks.plan.mockRejectedValue(new Error('Source unavailable')); mocks.listExport.mockResolvedValue([saved])
    let release!: (value: typeof shareReview) => void
    mocks.export.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    await act(async () => root.render(<DesktopCoworkerShareLauncher workspaceId={2} agentId="researcher" agentName="Researcher" onClose={() => {}} onOpenCoworker={() => {}} />))
    await act(async () => { [...document.querySelectorAll('button')].find(button => button.textContent?.startsWith('Recover saved export'))!.click() })
    await act(async () => root.render(null))
    await act(async () => { release(shareReview) })
    expect(mocks.forgetExport).not.toHaveBeenCalled(); expect(mocks.downloadUrl).not.toHaveBeenCalled()
    expect(mocks.export).toHaveBeenCalledTimes(1); expect(mocks.export).toHaveBeenCalledWith(saved)
})
