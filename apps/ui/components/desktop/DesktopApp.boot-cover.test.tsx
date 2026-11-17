// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { desktopBackgroundRead } from '@/test/desktop-background-fixture'
import { useAppBootStore } from '@/stores/app-boot.store'
import { DesktopApp } from './DesktopApp'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const initialData = { profile: { id: 1, displayName: 'Local User' }, workspace: { id: 1, name: 'My workspace' }, agents: [], theme: 'system' as const, default: null, connections: [] }
let root: Root, host: HTMLDivElement
let view: { resolve(value: Response): void }, previews: { resolve(value: Response): void }
const gate = () => { let resolve!: (value: Response) => void; const promise = new Promise<Response>(done => { resolve = done }); return { promise, resolve } }

beforeEach(() => {
    useAppBootStore.setState({ boardReady: false, holds: 0 })
    const viewGate = gate(), previewsGate = gate()
    view = viewGate; previews = previewsGate
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input), 'http://local').pathname
        if (path === '/api/desktop/workspace-view' && !init?.method) return viewGate.promise
        if (path === '/api/desktop/coworker-previews') return previewsGate.promise
        if (path === '/api/desktop/board-activity') return Response.json({ agents: {} })
        return desktopBackgroundRead(input, init) ?? Response.json({ error: 'not in this test' }, { status: 404 })
    }))
    host = document.body.appendChild(document.createElement('div')); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() })

// The cover is the app's loader over the whole frame; it fades out, so it is looked for until it has gone.
const cover = () => [...host.querySelectorAll<HTMLElement>('main > div')].find(node => node.className.includes('z-[60]')) ?? null
const wait = (ms: number) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) })
async function gone(within = 1500) {
    for (let waited = 0; waited < within && cover(); waited += 50) await wait(50)
    return cover() === null
}

test('one loader covers the app until the saved view is known, and the board then shows in one go', async () => {
    await act(async () => { root.render(<DesktopApp initialData={initialData} />) })
    expect(cover()?.textContent).toContain('Loading...')
    // The board is already under it: nothing waits to be drawn.
    expect(host.querySelector('[data-desktop-board-frame]')).not.toBeNull()
    await wait(150)
    expect(cover()).not.toBeNull()
    await act(async () => { view.resolve(Response.json({ view: 'board', lastOpened: null })) })
    expect(await gone()).toBe(true)
    expect(host.querySelector('[data-testid="desktop-simple-view"]')).toBeNull()
})

test('in the Simple view the loader stays until its list is read, so the board never flashes first', async () => {
    await act(async () => { root.render(<DesktopApp initialData={initialData} />) })
    await act(async () => { view.resolve(Response.json({ view: 'simple', lastOpened: null })) })
    await wait(300)
    // The Simple view is in place under the cover, its list still being read.
    expect(host.querySelector('[data-testid="desktop-simple-view"]')).not.toBeNull()
    expect(cover()).not.toBeNull()
    await act(async () => { previews.resolve(Response.json({ previews: {} })) })
    expect(await gone()).toBe(true)
})

test('a slow read does not keep the app behind the loader: it lifts after 2.5 seconds', async () => {
    await act(async () => { root.render(<DesktopApp initialData={initialData} />) })
    await act(async () => { view.resolve(Response.json({ view: 'simple', lastOpened: null })) })
    await wait(1500)
    expect(cover()).not.toBeNull()
    expect(await gone(2500)).toBe(true)
    // Lifted once per launch: a read that lands later does not bring it back.
    await act(async () => { previews.resolve(Response.json({ previews: {} })) })
    await wait(100)
    expect(cover()).toBeNull()
})
