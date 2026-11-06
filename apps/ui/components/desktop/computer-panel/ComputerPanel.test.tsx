// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { ComputerPanelPorts, ComputerPanelProjection } from '@/lib/desktop/computer-panel/contract'

import { ComputerPanel } from './ComputerPanel'

vi.mock('@/components/desktop/browser-runs/BrowserRunScreen', () => ({
    BrowserRunScreen: ({ onOpenFullViewer }: { onOpenFullViewer: () => Promise<void> }) => <button onClick={() => void onOpenFullViewer().catch(() => {})}>Take control</button>,
}))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const G = 'a'.repeat(32)
const projection = (over: Partial<ComputerPanelProjection> = {}): ComputerPanelProjection => ({
    workspaceId: 'ws', generation: G, coworker: { enabled: true, deleted: false }, takeover: null, runtime: { kind: 'running' },
    grants: { computer: true, browser: true, terminalLaunch: true, filesLaunch: false }, capability: { terminalInstalled: true, filesInstalled: true }, humanDriving: false,
    current: { agentId: 'a', sessionId: 's', runId: 'r', liveScreen: { kind: 'computer', site: null } }, ...over,
})
let root: Root, host: HTMLDivElement
const ports = () => ({
    checkCurrentRun: vi.fn<ComputerPanelPorts['checkCurrentRun']>(), transport: { requestWatchTicket: vi.fn() },
    openFullViewer: vi.fn<ComputerPanelPorts['openFullViewer']>(async () => {}), launchApp: vi.fn<ComputerPanelPorts['launchApp']>(async () => ({ status: 'opened' as const })), revalidateOwner: vi.fn<ComputerPanelPorts['revalidateOwner']>(async () => true),
})
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })

async function render(read: () => Promise<ComputerPanelProjection | null>, p = ports(), extra: { onReturnFocus?: () => void } = {}) {
    await act(async () => {
        root.render(<ComputerPanel agentId="a" sessionId="s" active selected fullViewerOpen={false} readProjection={read} ports={p} humanLaunchMounted
            scroller={null} floatingHost={null} fallback={<span>working…</span>} {...extra} />)
    })
    return p
}
const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)

test('Files is disabled with its own grant reason; Terminal launches through the injected port once', async () => {
    const p = await render(async () => projection())
    expect(button('Files')?.disabled).toBe(true)
    expect(button('Files')?.title).toContain('launcher permission')
    await act(async () => { button('Terminal')!.click(); button('Terminal')?.click() })
    expect(p.launchApp).toHaveBeenCalledTimes(1)
    expect(p.revalidateOwner).toHaveBeenCalled()
})

test('opening and hiding never acquire a lease; Take control only asks root after revalidation', async () => {
    const p = await render(async () => projection())
    await act(async () => { host.querySelector<HTMLButtonElement>('button:not([aria-label])')!.click() })
    expect(p.revalidateOwner).toHaveBeenCalledBefore(p.openFullViewer as never)
    expect(p.openFullViewer).toHaveBeenCalledWith(expect.objectContaining({ runId: 'r', generation: G }), { app: 'browser' })
})

test('Escape hides, duplicate polls do not reopen, Show screen restores and focus returns', async () => {
    vi.useFakeTimers()
    const onReturnFocus = vi.fn()
    await render(async () => projection(), ports(), { onReturnFocus })
    const region = host.querySelector('[role="region"]')!
    await act(async () => { region.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(onReturnFocus).toHaveBeenCalled()
    await act(async () => { vi.advanceTimersByTime(6000) })
    expect(host.textContent).toContain('Show screen')
    await act(async () => { [...host.querySelectorAll('button')].find(b => b.textContent?.includes('Show screen'))!.click() })
    expect(host.querySelector('[role="region"]')).not.toBeNull()
    vi.useRealTimers()
})

test('stale reply for another session is ignored and history shows the fallback', async () => {
    await render(async () => projection({ current: { agentId: 'a', sessionId: 'other', runId: 'r', liveScreen: { kind: 'computer', site: null } } }))
    expect(host.textContent).toContain('working…')
    expect(host.querySelector('[role="region"]')).toBeNull()
})

 test('a closed panel cancels delayed Browser opening before the root viewer callback', async () => {
    let finish!: (value: boolean) => void
    const p = ports(); p.revalidateOwner.mockImplementation(() => new Promise<boolean>(resolve => { finish = resolve }))
    await render(async () => projection(), p)
    await act(async () => { button('Browser')!.click() })
    await act(async () => root.render(null))
    await act(async () => { finish(true) })
    expect(p.openFullViewer).not.toHaveBeenCalled()
 })
 test('inactive panels do not read computer state', async () => {
    const read = vi.fn(async () => projection())
    await act(async () => root.render(<ComputerPanel agentId="a" sessionId="s" active={false} selected={false} fullViewerOpen={false} readProjection={read} ports={ports()} humanLaunchMounted scroller={null} floatingHost={null} fallback={<span>working</span>} />))
    expect(read).not.toHaveBeenCalled()
 })
 test('hiding and reopening keeps the uncertain request identity', async () => {
    const p = ports(); p.launchApp.mockRejectedValueOnce(new Error('Lost ACK'))
    await render(async () => projection(), p)
    await act(async () => { button('Terminal')!.click() })
    const first = p.launchApp.mock.calls[0]![2]
    await act(async () => { button('Hide screen')!.click() })
    await act(async () => { [...host.querySelectorAll('button')].find(b => b.textContent?.includes('Show screen'))!.click() })
    await act(async () => { [...host.querySelectorAll('button')].find(b => b.textContent === 'Try again')!.click() })
    expect(p.launchApp.mock.calls[1]![2]).toBe(first)
 })
