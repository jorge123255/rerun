import { expect, it, vi } from 'vitest'
import { controlContextAvailable } from './context'
import { originalControlLabels } from './labels'
import { FolderIcon } from '@/lib/icons'
const context = { open: true, disabled: false, scope: 'palette-cycle:query', runtimeWorkspaceId: 1, board: { revision: 4 } }
it('rejects changed workspace, board, query, closed and denied context without adopting workspace one', () => {
    expect(controlContextAvailable(context, context, false)).toBe(true)
    for (const current of [{ ...context, runtimeWorkspaceId: 2 }, { ...context, runtimeLaunchNonce: 'replacement-runtime' }, { ...context, runtimeWorkspaceId: undefined }, { ...context, scope: 'new query' }, { ...context, board: { revision: 5 } }, { ...context, open: false }, { ...context, disabled: true }]) expect(controlContextAvailable(context, current, false)).toBe(false)
    expect(controlContextAvailable(context, context, true)).toBe(false)
})
it('uses original global labels without changing navigation, IDs, chat names, files or drafts', () => {
    const onSelect = vi.fn(), onDrill = vi.fn()
    const rows = ['command-add_coworker','command-model_settings','command-team_board','open-chat-draft'].map(id => ({ id, label: 'Original user text', leading: { kind: 'icon' as const, icon: FolderIcon }, onSelect, onDrill }))
    const sections = originalControlLabels([{ id: 'actions', heading: 'Actions', rows }], false)
    expect(sections[0].rows.map(row => row.label)).toEqual(['New agent','AI providers','Original user text','Original user text'])
    expect(sections[0].rows[0].onSelect).toBe(onSelect); expect(sections[0].rows[0].onDrill).toBe(onDrill)
    expect(rows[0].label).toBe('Original user text')
})
it('keeps denial explanations intact and chooses original dynamic theme copy', () => {
    const onSelect = vi.fn()
    const sections = originalControlLabels([{ id: 'settings', heading: 'Settings', rows: [{ id: 'command-toggle_theme', label: 'Old label', disabledReason: 'Workspace busy', leading: { kind: 'icon', icon: FolderIcon }, onSelect }] }], true)
    expect(sections[0].rows[0]).toMatchObject({ label: 'Switch to light theme', disabledReason: 'Workspace busy', onSelect })
})
