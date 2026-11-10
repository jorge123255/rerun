// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { DesktopBrainFolder } from './DesktopBrainFiles'
import { authorizedSharedFilePath } from '../pages/shared-file-link'
import type { FileList } from '@/components/files/FileList'
type ListProps = ComponentProps<typeof FileList>
const harness = vi.hoisted(() => ({ rename: vi.fn(), list: null as ListProps | null }))
vi.mock('@/lib/desktop/shared-workspace-files', () => ({ renameDesktopSharedFile: (...args: unknown[]) => harness.rename(...args) }))
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
