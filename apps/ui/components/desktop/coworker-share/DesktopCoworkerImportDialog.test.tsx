// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { createDesktopCoworkerShareAttempts } from '@/lib/desktop/coworker-share/attempts'
import type { DesktopCoworkerShareClient } from '@/lib/desktop/coworker-share/client'
import { shareManifest } from './test-fixtures'
import { DesktopCoworkerImportDialog } from './DesktopCoworkerImportDialog'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.replaceChildren() })
const button = (label: string) => [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === label)

test('fresh-copy navigation happens only after an acknowledged import and an explicit click', async () => {
    const api = {
        plan: vi.fn(), review: vi.fn(), export: vi.fn(), preview: vi.fn(async () => shareManifest), downloadUrl: vi.fn(),
        import: vi.fn(async () => ({ status: 'imported' as const, importedAgentId: 'fresh-a' })), revoke: vi.fn(), dispose: vi.fn(),
    } as DesktopCoworkerShareClient
    const onOpenCoworker = vi.fn()
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<DesktopCoworkerImportDialog open onOpenChange={() => {}} client={api} attempts={createDesktopCoworkerShareAttempts()} targetWorkspaceId={2} snapshotId={shareManifest.packageKey} onOpenCoworker={onOpenCoworker} />))
    await act(async () => (document.querySelector('[aria-label="I reviewed what this coworker carries"]') as HTMLButtonElement).click())
    await act(async () => button('Add a fresh copy')!.click())
    expect(api.import).toHaveBeenCalledOnce()
    expect(onOpenCoworker).not.toHaveBeenCalled()
    await act(async () => button('Open fresh copy')!.click())
    expect(onOpenCoworker).toHaveBeenCalledExactlyOnceWith('fresh-a')
})

test('Cancel preserves the source and never imports', async () => {
    const api = { preview: vi.fn(async () => shareManifest), import: vi.fn(), dispose: vi.fn() } as unknown as DesktopCoworkerShareClient
    const onOpenChange = vi.fn()
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<DesktopCoworkerImportDialog open onOpenChange={onOpenChange} client={api} attempts={createDesktopCoworkerShareAttempts()} targetWorkspaceId={2} snapshotId={shareManifest.packageKey} />))
    await act(async () => button('Cancel')!.click())
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(api.import).not.toHaveBeenCalled()
})
