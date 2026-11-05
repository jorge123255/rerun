// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { TableCard } from '@rerun/contracts'
import { DesktopTableCard } from './DesktopTableCard'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.innerHTML = '' })

const card: TableCard = {
    kind: 'table', scope: 'agent', table: 'deals', view: 'Pipeline',
    columns: ['name', 'stage'], rows: [{ name: 'Acme', stage: 'Won' }], total: 1, columnsTruncated: false,
}

const views = (names: string[]) => names.map((name, position) => ({ id: `v${position}`, table: 'deals', name, position }))

function listViews(names: string[]) {
    const fetcher = vi.fn(async (url: string) => {
        const request = new URL(url, 'http://127.0.0.1')
        expect(request.pathname).toBe('/api/desktop/agents/agent%201/data/tables/deals/views')
        return new Response(JSON.stringify({ views: views(names) }), { headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetcher)
    return fetcher
}

const openButton = () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Open database')
const click = async (button: HTMLButtonElement) => { await act(async () => { button.click() }) }

async function withCard(element: ReactNode, action: () => Promise<void>) {
    const root = createRoot(document.body.appendChild(document.createElement('div')))
    try {
        await act(async () => root.render(element))
        await action()
    } finally { await act(async () => root.unmount()) }
}

test('draws the original card frame and opens the exact view it names', async () => {
    listViews(['Pipeline'])
    const onOpen = vi.fn()
    await withCard(<DesktopTableCard card={card} agentId="agent 1" onOpen={onOpen} />, async () => {
        expect(document.querySelector('[data-desktop-table-card]')).not.toBeNull()
        expect(document.body.textContent).toContain('deals')
        expect(document.body.textContent).toContain('Acme')
        expect(document.body.textContent).toContain('1 row')
        const button = openButton()
        expect(button, 'Open database').toBeDefined()
        expect(button!.disabled).toBe(false)
        await click(button!)
        expect(onOpen).toHaveBeenCalledWith({ table: 'deals', view: 'Pipeline' })
        expect(document.body.textContent).not.toContain('deleted')
    })
})

test('says a deleted view is gone and opens the table instead of another view', async () => {
    listViews([])
    const onOpen = vi.fn()
    await withCard(<DesktopTableCard card={card} agentId="agent 1" onOpen={onOpen} />, async () => {
        await act(async () => {})
        expect(document.body.textContent).toContain('The view “Pipeline” was deleted.')
        expect(document.body.textContent).toContain('Database view editor')
        await click(openButton()!)
        expect(onOpen).toHaveBeenCalledWith({ table: 'deals' })
    })
})

test('opens the shared table through the shared panel when the card says shared', async () => {
    const shared: TableCard = { ...card, scope: 'shared' }
    const fetcher = vi.fn(async (url: string) => {
        const request = new URL(url, 'http://127.0.0.1')
        expect(request.pathname).toBe('/api/desktop/shared-data/tables/deals/views')
        return new Response(JSON.stringify(views(['Pipeline'])), { headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetcher)

    const onOpen = vi.fn()
    await withCard(<DesktopTableCard card={shared} agentId="agent 1" onOpen={onOpen} />, async () => {
        await click(openButton()!)
        expect(onOpen).toHaveBeenCalledWith({ table: 'deals', view: 'Pipeline' })
        expect(fetcher).toHaveBeenCalled()
    })
})

test('offers no open target when the conversation names no coworker', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const onOpen = vi.fn()
    await withCard(<DesktopTableCard card={card} onOpen={onOpen} />, async () => {
        const button = openButton()
        expect(button!.disabled).toBe(true)
        await click(button!)
        expect(onOpen).not.toHaveBeenCalled()
        expect(fetcher).not.toHaveBeenCalled()
    })
})

test('renders nothing rather than a fabricated card for a malformed payload', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const broken = { ...card, rows: Array.from({ length: 21 }, () => ({ name: 'x', stage: 'y' })) } as TableCard
    await withCard(<DesktopTableCard card={broken} agentId="agent 1" onOpen={vi.fn()} />, async () => {
        expect(document.querySelector('[data-desktop-table-card]')).toBeNull()
        expect(fetcher).not.toHaveBeenCalled()
    })
})
