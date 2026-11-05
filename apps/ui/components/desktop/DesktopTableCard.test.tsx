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
        expect(onOpen).toHaveBeenCalledWith({ table: 'deals', view: 'v0' })
        expect(document.body.textContent).not.toContain('deleted')
    })
})

test('keeps the frozen card visible without fetching, and refuses to open a different view after deletion', async () => {
    const fetcher = listViews([])
    const onOpen = vi.fn()
    await withCard(<DesktopTableCard card={card} agentId="agent 1" onOpen={onOpen} />, async () => {
        expect(fetcher).not.toHaveBeenCalled()
        await click(openButton()!)
        expect(document.body.textContent).toContain('The view “Pipeline” is no longer available.')
        expect(document.body.textContent).toContain('Database view editor')
        expect(onOpen).not.toHaveBeenCalled()
    })
})

test('opens the shared table through the shared panel when the card says shared', async () => {
    const shared: TableCard = { ...card, scope: 'shared' }
    const fetcher = vi.fn(async (url: string) => {
        const request = new URL(url, 'http://127.0.0.1')
        expect(request.pathname).toBe('/api/desktop/shared-data/tables/deals/views')
        return new Response(JSON.stringify({ views: views(['Pipeline']) }), { headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetcher)

    const onOpen = vi.fn()
    await withCard(<DesktopTableCard card={shared} agentId="agent 1" onOpen={onOpen} />, async () => {
        await click(openButton()!)
        expect(onOpen).toHaveBeenCalledWith({ table: 'deals', view: 'v0' })
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

test('a failed view lookup cannot open a fallback and can be retried from the same card', async () => {
    const fetcher = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Database is unavailable.' }), { status: 503 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ views: views(['Pipeline']) })))
    vi.stubGlobal('fetch', fetcher)
    const onOpen = vi.fn()
    await withCard(<DesktopTableCard card={card} agentId="agent 1" onOpen={onOpen} />, async () => {
        await click(openButton()!)
        expect(onOpen).not.toHaveBeenCalled()
        expect(document.body.textContent).toContain('Database is unavailable.')
        await click(openButton()!)
        expect(onOpen).toHaveBeenCalledExactlyOnceWith({ table: 'deals', view: 'v0' })
        expect(document.body.textContent).not.toContain('Database is unavailable.')
    })
})

test('a deferred lookup belongs to its exact coworker and cannot open after an owner change or unmount', async () => {
    const pending: ((response: Response) => void)[] = []
    const fetcher = vi.fn(() => new Promise<Response>(resolve => pending.push(resolve)))
    vi.stubGlobal('fetch', fetcher)
    const onOpen = vi.fn()
    const root = createRoot(document.body.appendChild(document.createElement('div')))
    const response = () => new Response(JSON.stringify({ views: views(['Pipeline']) }))
    await act(async () => root.render(<DesktopTableCard card={card} agentId="first" onOpen={onOpen} />))
    await click(openButton()!)
    expect(openButton()!.disabled).toBe(true)
    await act(async () => root.render(<DesktopTableCard card={card} agentId="second" onOpen={onOpen} />))
    await click(openButton()!)
    await act(async () => pending[0](response()))
    expect(onOpen).not.toHaveBeenCalled()
    expect(openButton()!.disabled).toBe(true)
    await act(async () => root.unmount())
    await act(async () => pending[1](response()))
    expect(onOpen).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledTimes(2)
})

test('a shared snapshot without a trusted coworker cannot browse the workspace', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const onOpen = vi.fn()
    await withCard(<DesktopTableCard card={{ ...card, scope: 'shared' }} onOpen={onOpen} />, async () => {
        expect(openButton()!.disabled).toBe(true)
        await click(openButton()!)
        expect(fetcher).not.toHaveBeenCalled()
        expect(onOpen).not.toHaveBeenCalled()
    })
})
