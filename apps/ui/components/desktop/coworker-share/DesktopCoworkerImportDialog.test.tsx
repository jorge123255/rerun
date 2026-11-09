// @vitest-environment happy-dom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { createDesktopCoworkerShareAttempts } from '@/lib/desktop/coworker-share/attempts'
import type { DesktopCoworkerShareClient } from '@/lib/desktop/coworker-share/client'
import { importInspection, shareManifest } from './test-fixtures'
import { DesktopCoworkerImportDialog } from './DesktopCoworkerImportDialog'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.replaceChildren() })
const button = (label: string) => [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === label)

test('verified private counts precede approval and importing retains the manifest digest', async () => {
    const api = { inspect: vi.fn(async () => importInspection(shareManifest,{ status: 'verified',contents: { count: 2,bytes: 540 },viewCount: 3,digest: '1'.repeat(64) })),import: vi.fn(async () => ({ status: 'imported',importedAgentId: 'fresh-a' })) } as unknown as DesktopCoworkerShareClient
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<DesktopCoworkerImportDialog open onOpenChange={() => {}} client={api} attempts={createDesktopCoworkerShareAttempts()} targetWorkspaceId={2} snapshotId={shareManifest.packageKey} />))
    const text = document.body.textContent!
    expect(text).toContain('2 private tables · 3 saved views')
    expect(text.indexOf('2 private tables')).toBeLessThan(text.indexOf('I reviewed what this coworker carries'))
    expect(text).toContain(`Database SHA-256 ${'1'.repeat(64)}`)
    expect(button('Add a fresh copy')!.disabled).toBe(true)
    expect(api.import).not.toHaveBeenCalled()
    expect([...document.querySelectorAll('button')].every(control => control.type === 'button')).toBe(true)
    await act(async () => (document.querySelector('[aria-label="I reviewed what this coworker carries"]') as HTMLButtonElement).click())
    await act(async () => button('Add a fresh copy')!.click())
    expect(api.import).toHaveBeenCalledWith(expect.objectContaining({ snapshotId: shareManifest.packageKey,expectedDigest: shareManifest.contentDigest,targetWorkspaceId: 2 }))
})

test.each(['legacy','unavailable'] as const)('unsupported %s inspection cannot approve, import or invent zero counts', async status => {
    const api = { inspect: vi.fn(async () => importInspection(shareManifest,{ status })),import: vi.fn() } as unknown as DesktopCoworkerShareClient
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<DesktopCoworkerImportDialog open onOpenChange={() => {}} client={api} attempts={createDesktopCoworkerShareAttempts()} targetWorkspaceId={2} snapshotId={shareManifest.packageKey} />))
    expect(document.body.textContent).toContain(status === 'legacy' ? 'raw SQLite database member' : 'Database inspection is unavailable')
    expect(document.body.textContent).not.toContain('0 private tables')
    expect((document.querySelector('[aria-label="I reviewed what this coworker carries"]') as HTMLButtonElement).disabled).toBe(true)
    expect(button('Add a fresh copy')!.disabled).toBe(true)
    await act(async () => button('Add a fresh copy')!.click())
    expect(api.import).not.toHaveBeenCalled()
})

test('absent and verified empty database sections are described differently', async () => {
    const api = { inspect: vi.fn(async () => importInspection()),import: vi.fn() } as unknown as DesktopCoworkerShareClient
    root = createRoot(document.body.appendChild(document.createElement('div')))
    const props = { open: true,onOpenChange: () => {},attempts: createDesktopCoworkerShareAttempts(),targetWorkspaceId: 2,snapshotId: shareManifest.packageKey }
    await act(async () => root!.render(<DesktopCoworkerImportDialog {...props} client={api} />))
    expect(document.body.textContent).toContain('does not include a logical private database section')
    expect(document.body.textContent).not.toContain('0 private tables')
    const empty = { ...api,inspect: vi.fn(async () => importInspection(shareManifest,{ status: 'verified',contents: { count: 0,bytes: 24 },viewCount: 0,digest: '2'.repeat(64) })) }
    await act(async () => root!.render(<DesktopCoworkerImportDialog {...props} client={empty} />))
    expect(document.body.textContent).toContain('0 private tables · 0 saved views')
    expect(api.import).not.toHaveBeenCalled()
})

test('invalid database inspection exposes an error and no approval control', async () => {
    const api = { inspect: vi.fn(async () => { throw new Error('The portable database section could not be verified.') }),import: vi.fn() } as unknown as DesktopCoworkerShareClient
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<DesktopCoworkerImportDialog open onOpenChange={() => {}} client={api} attempts={createDesktopCoworkerShareAttempts()} targetWorkspaceId={2} snapshotId={shareManifest.packageKey} />))
    expect(document.body.textContent).toContain('could not be verified')
    expect(document.querySelector('[aria-label="I reviewed what this coworker carries"]')).toBeNull()
    expect(button('Add a fresh copy')!.disabled).toBe(true)
    expect(api.import).not.toHaveBeenCalled()
})

test('fresh-copy navigation happens only after an acknowledged import and an explicit click', async () => {
    const api = {
        plan: vi.fn(), review: vi.fn(), export: vi.fn(), preview: vi.fn(), inspect: vi.fn(async () => importInspection()), downloadUrl: vi.fn(),
        import: vi.fn(async () => ({ status: 'imported' as const, importedAgentId: 'fresh-a' })), revoke: vi.fn(), dispose: vi.fn(),
    } as DesktopCoworkerShareClient
    const onOpenCoworker = vi.fn(), onImported = vi.fn()
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<StrictMode><DesktopCoworkerImportDialog open onOpenChange={() => {}} client={api} attempts={createDesktopCoworkerShareAttempts()} targetWorkspaceId={2} snapshotId={shareManifest.packageKey} onImported={onImported} onOpenCoworker={onOpenCoworker} /></StrictMode>))
    await act(async () => (document.querySelector('[aria-label="I reviewed what this coworker carries"]') as HTMLButtonElement).click())
    await act(async () => button('Add a fresh copy')!.click())
    expect(api.import).toHaveBeenCalledOnce()
    expect(onImported).toHaveBeenCalledExactlyOnceWith('fresh-a')
    expect(onOpenCoworker).not.toHaveBeenCalled()
    await act(async () => button('Open fresh copy')!.click())
    expect(onOpenCoworker).toHaveBeenCalledExactlyOnceWith('fresh-a')
})

test('the exact archive review explains when the exporter left Files off', async () => {
    const note = 'Workspace files were left out of this export.'
    const manifest = { ...shareManifest, fidelity: { ...shareManifest.fidelity, notes: [...shareManifest.fidelity.notes, note] } }
    const api = { inspect: vi.fn(async () => importInspection(manifest)), import: vi.fn(), dispose: vi.fn() } as unknown as DesktopCoworkerShareClient
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<DesktopCoworkerImportDialog open onOpenChange={() => {}} client={api} attempts={createDesktopCoworkerShareAttempts()} targetWorkspaceId={2} snapshotId={manifest.packageKey} />))
    expect(document.body.textContent).toContain(note)
    expect(api.import).not.toHaveBeenCalled()
})

test('Cancel preserves the source and never imports', async () => {
    const api = { inspect: vi.fn(async () => importInspection()), import: vi.fn(), dispose: vi.fn() } as unknown as DesktopCoworkerShareClient
    const onOpenChange = vi.fn(), onImported = vi.fn(), onOpenCoworker = vi.fn()
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<DesktopCoworkerImportDialog open onOpenChange={onOpenChange} client={api} attempts={createDesktopCoworkerShareAttempts()} targetWorkspaceId={2} snapshotId={shareManifest.packageKey} onImported={onImported} onOpenCoworker={onOpenCoworker} />))
    await act(async () => button('Cancel')!.click())
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(api.import).not.toHaveBeenCalled()
    expect(onImported).not.toHaveBeenCalled(); expect(onOpenCoworker).not.toHaveBeenCalled()
})

test('a current in-flight import does not claim an earlier uncertain ACK; unknown recovery notifies the board before Done without navigation', async () => {
    let release!: (value: { status: 'uncertain'; recoverable: true; reason: string }) => void
    const api = { inspect: vi.fn(async () => importInspection()),import: vi.fn().mockImplementationOnce(() => new Promise(resolve => { release = resolve })).mockResolvedValueOnce({ status: 'imported',importedAgentId: 'recovered-a' }),dispose: vi.fn() } as unknown as DesktopCoworkerShareClient
    const onImported = vi.fn(() => new Promise<void>(() => {})), onOpenCoworker = vi.fn(), onOpenChange = vi.fn()
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<DesktopCoworkerImportDialog open onOpenChange={onOpenChange} client={api} attempts={createDesktopCoworkerShareAttempts()} targetWorkspaceId={2} snapshotId={shareManifest.packageKey} onImported={onImported} onOpenCoworker={onOpenCoworker} />))
    await act(async () => (document.querySelector('[aria-label="I reviewed what this coworker carries"]') as HTMLButtonElement).click())
    await act(async () => button('Add a fresh copy')!.click())
    expect(document.body.textContent).toContain('Adding the fresh copy')
    expect(document.body.textContent).not.toContain('An earlier import acknowledgement is uncertain')
    expect(onImported).not.toHaveBeenCalled()
    await act(async () => { release({ status: 'uncertain',recoverable: true,reason: 'Unknown acknowledgement' }) })
    expect(document.body.textContent).toContain('An earlier import acknowledgement is uncertain')
    const recover = [...document.querySelectorAll('button')].find(item => item.textContent?.startsWith('Recover import'))!
    await act(async () => recover.click())
    expect(api.import).toHaveBeenCalledTimes(2)
    expect(vi.mocked(api.import).mock.calls[0]![0]).toEqual(vi.mocked(api.import).mock.calls[1]![0])
    expect(onImported).toHaveBeenCalledExactlyOnceWith('recovered-a')
    expect(button('Done')).toBeTruthy()
    await act(async () => button('Done')!.click())
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onOpenCoworker).not.toHaveBeenCalled()
})

test('a board-refresh rejection keeps the acknowledged copy and cannot create another reservation', async () => {
    const api = { inspect: vi.fn(async () => importInspection()),import: vi.fn(async () => ({ status: 'imported' as const,importedAgentId: 'fresh-refresh-error' })),dispose: vi.fn() } as unknown as DesktopCoworkerShareClient
    const onImported = vi.fn(async () => { throw new Error('Board unavailable') })
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<DesktopCoworkerImportDialog open onOpenChange={() => {}} client={api} attempts={createDesktopCoworkerShareAttempts()} targetWorkspaceId={2} snapshotId={shareManifest.packageKey} onImported={onImported} />))
    await act(async () => (document.querySelector('[aria-label="I reviewed what this coworker carries"]') as HTMLButtonElement).click())
    await act(async () => button('Add a fresh copy')!.click())
    expect(api.import).toHaveBeenCalledTimes(1)
    expect(onImported).toHaveBeenCalledExactlyOnceWith('fresh-refresh-error')
    expect(document.body.textContent).toContain('fresh copy is saved')
    expect(button('Done')).toBeTruthy(); expect(button('Add a fresh copy')).toBeUndefined()
})
