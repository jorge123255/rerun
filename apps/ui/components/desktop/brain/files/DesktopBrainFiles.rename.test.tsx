// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { DesktopBrainFolder } from './DesktopBrainFiles'
import { authorizedSharedFilePath } from '../pages/shared-file-link'
import type { FileList } from '@/components/files/FileList'
type ListProps = ComponentProps<typeof FileList>
const harness = vi.hoisted(() => ({ rename: vi.fn(), remove: vi.fn(), list: null as ListProps | null }))
vi.mock('@/lib/desktop/shared-workspace-files', () => ({
    renameDesktopSharedFile: (...args: unknown[]) => harness.rename(...args),
    deleteDesktopSharedEntry: (...args: unknown[]) => harness.remove(...args),
}))
vi.mock('@/components/files/FileList', () => ({ FileList: (props: ListProps) => { harness.list = props; return null } }))
vi.mock('@/components/brain/BrainTopBar', () => ({ BrainTopBar: () => null }))
vi.mock('@/components/desktop/shared-files/DesktopSharedImportResults', () => ({ DesktopSharedImportResults: () => null }))
vi.mock('@/components/desktop/shared-files/DesktopSharedFilePreview', () => ({ DesktopSharedFilePreview: () => null }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

it('reuses authorized file rename, refreshes exact folder and makes old page path inert', async () => {
    const host = document.createElement('div'), root = createRoot(host)
    let known = [{ path: 'docs/old.md', name: 'old.md' }]
    const refresh = vi.fn(async (dir: string) => { expect(dir).toBe('docs'); known = [{ path: 'docs/new.md', name: 'new.md' }] })
    const files = { expand: vi.fn(), refresh, entriesOf: () => [{ name: 'old.md', type: 'file' }, { name: 'folder', type: 'dir' }] } as unknown as ComponentProps<typeof DesktopBrainFolder>['files']
    harness.rename.mockReset().mockResolvedValue({ path: 'docs/new.md', name: 'new.md' })
    try {
        await act(async () => root.render(createElement(DesktopBrainFolder, { path: 'docs', files, onSelect: vi.fn(), onUpload: vi.fn(), importResults: [], importing: false, onRetryImport: vi.fn() })))
        const { canRename, onRename } = harness.list ?? {}
        if (!canRename || !onRename) throw new Error('Rename controls were not mounted')
        expect(canRename({ name: 'folder', type: 'dir', size: 0, modified: '' })).toBe(false)
        await act(async () => onRename('folder', 'other'))
        expect(harness.rename).not.toHaveBeenCalled()
        await act(async () => onRename('old.md', 'new.md'))
        expect(harness.rename).toHaveBeenCalledWith('docs/old.md', 'new.md', expect.any(AbortSignal))
        expect(refresh).toHaveBeenCalledTimes(1)
        expect(authorizedSharedFilePath('docs/old.md', known)).toBeNull()
        expect(authorizedSharedFilePath('docs/new.md', known)).toBe('docs/new.md')
        refresh.mockClear(); harness.rename.mockRejectedValue(new Error('collision'))
        await act(async () => onRename('old.md', 'taken.md'))
        expect(refresh).not.toHaveBeenCalled()
    } finally { await act(async () => root.unmount()) }
})

it('forgets an expanded folder in Company Brain only after its exact deletion is confirmed', async () => {
    const host = document.createElement('div'), root = createRoot(host)
    const folder = { name: 'past', type: 'dir' as const, size: 0, modified: '', deleteRevision: '5'.repeat(64) }
    const forget = vi.fn()
    const refresh = vi.fn()
    const files = { expand: vi.fn(), refresh, forget, entriesOf: () => [folder] } as unknown as ComponentProps<typeof DesktopBrainFolder>['files']
    try {
        await act(async () => root.render(createElement(DesktopBrainFolder, {
            path: 'docs', workspaceId: 7, files, onSelect: vi.fn(), onUpload: vi.fn(), importResults: [], importing: false, onRetryImport: vi.fn(),
        })))
        expect(harness.list?.canDelete?.(folder)).toBe(true)
        harness.remove.mockReset().mockRejectedValueOnce(new Error('unchanged')).mockResolvedValueOnce(undefined)
        await act(async () => harness.list?.onDelete?.(folder.name, folder))
        expect(forget).not.toHaveBeenCalled()
        expect(refresh).not.toHaveBeenCalled()
        await act(async () => harness.list?.onDelete?.(folder.name, folder))
        expect(harness.remove).toHaveBeenLastCalledWith(7, 'docs/past', folder.deleteRevision, expect.any(AbortSignal))
        expect(forget).toHaveBeenCalledExactlyOnceWith('docs/past')
        expect(refresh).toHaveBeenCalledExactlyOnceWith('docs')
    } finally { await act(async () => root.unmount()) }
})

it('uses the selected shared file and its version for Company Brain Save As', async () => {
    const host = document.createElement('div'), root = createRoot(host)
    const saveSharedFile = vi.fn().mockResolvedValue(true)
    vi.stubGlobal('desktopApp', { saveSharedFile })
    const file = { name: 'report.csv', type: 'file' as const, size: 8, modified: '', deleteRevision: '4'.repeat(64) }
    const files = { expand: vi.fn(), entriesOf: () => [file] } as unknown as ComponentProps<typeof DesktopBrainFolder>['files']
    try {
        await act(async () => root.render(createElement(DesktopBrainFolder, {
            path: 'docs', workspaceId: 7, files, onSelect: vi.fn(), onUpload: vi.fn(), importResults: [], importing: false, onRetryImport: vi.fn(),
        })))
        expect(harness.list?.downloadLabel).toBe('Save As')
        expect(harness.list?.canDownload?.({ ...file, type: 'dir' })).toBe(false)
        expect(harness.list?.canDownload?.({ ...file, deleteRevision: undefined })).toBe(false)
        expect(harness.list?.canDownload?.(file)).toBe(true)
        await act(async () => harness.list?.onDownload?.(file.name, file))
        expect(saveSharedFile).toHaveBeenCalledExactlyOnceWith({ workspaceId: 7, path: 'docs/report.csv', version: file.deleteRevision })
    } finally {
        await act(async () => root.unmount())
        vi.unstubAllGlobals()
    }
})
