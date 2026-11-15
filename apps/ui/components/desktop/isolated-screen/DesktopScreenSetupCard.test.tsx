// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopScreenSetup } from '@rerun/contracts'
import { DesktopScreenSetupCard } from './DesktopScreenSetupCard'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const idle = { state: 'idle' as const, step: null, steps: null, error: null }
let root: Root | undefined
afterEach(() => { if (root) act(() => root!.unmount()); root = undefined; document.body.innerHTML = ''; vi.unstubAllGlobals(); delete (window as { desktopApp?: unknown }).desktopApp })

async function mount(answers: DesktopScreenSetup[], onReady = vi.fn()) {
    const calls: Array<{ method: string; body: string | null }> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
        calls.push({ method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : null })
        return Response.json(answers.length > 1 ? answers.shift() : answers[0])
    }))
    const host = document.body.appendChild(document.createElement('div'))
    root = createRoot(host)
    await act(async () => { root!.render(<DesktopScreenSetupCard onReady={onReady} />) })
    await act(async () => { await Promise.resolve() })
    return { host, calls, onReady }
}
const buttons = (host: HTMLElement) => [...host.querySelectorAll('button')].map(button => button.textContent)

it('shows nothing when Docker, a running Docker and the screen are all there', async () => {
    const { host } = await mount([{ need: 'nothing', install: idle }])
    expect(host.textContent).toBe('')
})

it('offers the one step that is missing, and only that one', async () => {
    expect(buttons((await mount([{ need: 'docker', install: idle }])).host)).toEqual(['Get Docker Desktop'])
    act(() => root!.unmount()); document.body.innerHTML = ''
    ;(window as { desktopApp?: unknown }).desktopApp = { macSettings: { read: vi.fn(), setOpenAtLogin: vi.fn(), openDocker: vi.fn(async () => true) } }
    expect(buttons((await mount([{ need: 'docker-running', install: idle }])).host)).toEqual(['Open Docker'])
    act(() => root!.unmount()); document.body.innerHTML = ''
    expect(buttons((await mount([{ need: 'image', install: idle }])).host)).toEqual(['Install'])
})

it('installs only on a click, shows progress, and says so when the download failed', async () => {
    const { host, calls } = await mount([{ need: 'image', install: idle }, { need: 'image', install: idle }, { need: 'image', install: { state: 'installing', step: 3, steps: 9, error: null } }])
    expect(calls.every(call => call.method === 'GET')).toBe(true)
    await act(async () => { host.querySelector('button')!.click(); await Promise.resolve() })
    await act(async () => { await Promise.resolve() })
    expect(calls.filter(call => call.method === 'POST').map(call => JSON.parse(call.body!))).toEqual([{ action: 'install' }])
    expect(host.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow')).toBe('33')
    expect(buttons(host)).toEqual(['Cancel'])
    act(() => root!.unmount()); document.body.innerHTML = ''
    const failed = await mount([{ need: 'image', install: { state: 'failed', step: null, steps: null, error: 'offline' } }])
    expect(failed.host.querySelector('[role=alert]')?.textContent).toContain('Check your connection')
    expect(buttons(failed.host)).toEqual(['Try again'])
})
