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
    renameDesktopSharedEntry: (...args: unknown[]) => harness.rename(...args),
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
    const file = { name: 'old.md', type: 'file' as const, size: 1, modified: '', deleteRevision: 'a'.repeat(64) }
    const folder = { name: 'folder', type: 'dir' as const, size: 0, modified: '', deleteRevision: 'b'.repeat(64) }
    const files = { expand: vi.fn(), refresh, entriesOf: () => [file, folder] } as unknown as ComponentProps<typeof DesktopBrainFolder>['files']
    harness.rename.mockReset().mockResolvedValue({ path: 'docs/new.md', name: 'new.md' })
    try {
        await act(async () => root.render(createElement(DesktopBrainFolder, { path: 'docs', workspaceId: 7, files, onSelect: vi.fn(), onUpload: vi.fn(), importResults: [], importing: false, onRetryImport: vi.fn() })))
        const { canRename, onRename } = harness.list ?? {}
        if (!canRename || !onRename) throw new Error('Rename controls were not mounted')
        expect(canRename(folder)).toBe(true)
        expect(canRename({ ...folder, deleteRevision: undefined })).toBe(false)
        await act(async () => onRename(file.name, 'new.md', file))
        expect(harness.rename).toHaveBeenCalledWith(7, 'docs/old.md', 'new.md', file.deleteRevision, expect.any(AbortSignal))
        expect(refresh).toHaveBeenCalledTimes(1)
        expect(authorizedSharedFilePath('docs/old.md', known)).toBeNull()
        expect(authorizedSharedFilePath('docs/new.md', known)).toBe('docs/new.md')
        refresh.mockClear(); harness.rename.mockRejectedValue(new Error('collision'))
        await act(async () => onRename(file.name, 'taken.md', file))
        expect(refresh).not.toHaveBeenCalled()
    } finally { await act(async () => root.unmount()) }
})

it('moves the expanded folder to its acknowledged path and drops cached descendants only after success', async () => {
    const host = document.createElement('div'), root = createRoot(host)
    const original = { name: 'past', type: 'dir' as const, size: 0, modified: '', deleteRevision: '5'.repeat(64) }
    const replacement = { ...original, deleteRevision: '6'.repeat(64) }
    const forget = vi.fn(), refresh = vi.fn(), expand = vi.fn()
    const files = { expand, refresh, forget, expanded: new Set(['docs/past']), entriesOf: () => [replacement] } as unknown as ComponentProps<typeof DesktopBrainFolder>['files']
    try {
        await act(async () => root.render(createElement(DesktopBrainFolder, {
            path: 'docs', workspaceId: 7, files, onSelect: vi.fn(), onUpload: vi.fn(), importResults: [], importing: false, onRetryImport: vi.fn(),
        })))
        harness.rename.mockReset().mockRejectedValueOnce(new Error('stale')).mockResolvedValueOnce({ path: 'docs/archive', name: 'archive' })
        await act(async () => harness.list?.onRename?.(original.name, 'archive', original))
        expect(harness.rename).toHaveBeenCalledWith(7, 'docs/past', 'archive', original.deleteRevision, expect.any(AbortSignal))
        expect(forget).not.toHaveBeenCalled()
        await act(async () => harness.list?.onRename?.(replacement.name, 'archive', replacement))
        expect(forget).toHaveBeenCalledExactlyOnceWith('docs/past')
        expect(expand).toHaveBeenLastCalledWith('docs/archive')
        expect(refresh).toHaveBeenCalledExactlyOnceWith('docs')
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
