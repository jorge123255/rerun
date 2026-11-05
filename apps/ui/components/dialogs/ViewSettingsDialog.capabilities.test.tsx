// @vitest-environment happy-dom
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { desktopDataSource } from '@/lib/desktop/data-source'
import { ViewSettingsDialog } from './ViewSettingsDialog'

vi.mock('@/components/ui/dialog', () => ({
    Dialog: ({ children }: { children: ReactNode }) => <>{children}</>,
    DialogHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
    DialogTitle: ({ children }: { children: ReactNode }) => <h1>{children}</h1>,
    DialogFooter: ({ children }: { children: ReactNode }) => <footer>{children}</footer>,
}))
vi.mock('@/components/dialogs/SplitDialogContent', () => ({ SplitDialogContent: ({ children }: { children: ReactNode }) => <section>{children}</section> }))

const markup = (source: ReturnType<typeof desktopDataSource>) => renderToStaticMarkup(<ViewSettingsDialog
    open onOpenChange={() => {}} source={source} table="tasks" columns={['name']}
    sample={{ rows: [], total: 0 }} onSaved={() => {}}
/>)

it('offers the installed chat table-card capability for both desktop database scopes', () => {
    for (const source of [desktopDataSource({ kind: 'agent', agentId: 'owner' }), desktopDataSource({ kind: 'shared' })]) {
        expect(source.supportsTableCards).toBe(true)
        const html = markup(source)
        expect(html).toContain('Everyone who opens this table sees it.')
        expect(html).toContain('the coworker can draw it in chat')
    }
})

it('preserves the original hosted wording when the source does not opt out', () => {
    const { supportsTableCards: _desktopLimit, ...hosted } = desktopDataSource({ kind: 'shared' })
    expect(markup(hosted)).toContain('and the coworker can draw it in chat.')
})
