// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FriendlyColumn } from '@/lib/data/friendly-columns'

vi.mock('@/components/ui/sheet', () => ({
    Sheet: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? <div role="dialog">{children}</div> : null),
    SheetContent: ({ children }: { children: ReactNode }) => <>{children}</>,
    SheetHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    SheetTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
    SheetDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

import { LeadSourcesSheet } from './LeadSourcesSheet'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const title = (key: string, label = key): FriendlyColumn => ({ key, label, kind: 'title' })
const text = (key: string, label = key): FriendlyColumn => ({ key, label, kind: 'text' })
const boolean = (key: string, label = key): FriendlyColumn => ({ key, label, kind: 'boolean' })

let root: Root | undefined
let container: HTMLDivElement | undefined

async function render(node: ReactNode) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => { root!.render(node) })
}

afterEach(async () => {
    if (root) await act(async () => { root!.unmount() })
    container?.remove()
    root = undefined
    container = undefined
})

const detail = () => document.querySelector('[role="dialog"]')
const heading = () => detail()?.querySelector('h2')?.textContent

describe('LeadSourcesSheet all-fields detail', () => {
    it('lists non-empty fields and a false boolean, and omits an empty string', async () => {
        await render(
            <LeadSourcesSheet
                row={{ name: 'Ada', note: 'hello', is_active: false, blank: '' }}
                onOpenChange={vi.fn()}
                columns={[title('name', 'Name'), text('note', 'Note'), boolean('is_active', 'Active'), text('blank', 'Blank')]}
                sources={null}
            />,
        )
        const dialog = detail()
        expect(heading()).toBe('Ada')
        expect(dialog?.textContent).toContain('hello')
        expect(dialog?.textContent).toContain('Active')
        expect(dialog?.querySelector('[aria-label="No"]')).not.toBeNull()
        expect(dialog?.textContent).not.toContain('Blank')
        expect(dialog?.textContent).not.toContain('Open the source')
        expect(dialog?.querySelector('button')).toBeNull()
    })

    it('uses the first non-empty string when the title column is empty', async () => {
        await render(
            <LeadSourcesSheet
                row={{ name: '', note: 'Fallback' }}
                onOpenChange={vi.fn()}
                columns={[title('name', 'Name'), text('note', 'Note')]}
                sources={null}
            />,
        )
        expect(heading()).toBe('Fallback')
        expect(detail()?.textContent).not.toContain('Name')
    })

    it('titles a row with no string "Row"', async () => {
        await render(
            <LeadSourcesSheet
                row={{ is_active: false }}
                onOpenChange={vi.fn()}
                columns={[boolean('is_active', 'Active')]}
                sources={null}
            />,
        )
        expect(heading()).toBe('Row')
        expect(detail()?.querySelector('[aria-label="No"]')).not.toBeNull()
    })

    it('renders nothing when no row is open', async () => {
        await render(<LeadSourcesSheet row={null} onOpenChange={vi.fn()} columns={[text('note', 'Note')]} sources={null} />)
        expect(detail()).toBeNull()
    })
})
