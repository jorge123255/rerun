// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { DesktopCliToolStatus } from '@rerun/contracts'
import { DesktopCliToolVersion } from './DesktopCliUpdates'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []
afterEach(() => { for (const root of roots.splice(0)) act(() => { root.unmount() }); document.body.innerHTML = '' })
const base: DesktopCliToolStatus = { tool: 'kimi-code', current: '2.5.2', source: 'built-in', latest: '2.5.3', checkedAt: '2026-11-14T12:00:00.000Z', state: 'available', pending: null, error: null }
function mount(status: Partial<DesktopCliToolStatus>, onAct = vi.fn()) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    roots.push(root)
    act(() => { root.render(<DesktopCliToolVersion name="Kimi Code" status={{ ...base, ...status }} acting={false} onAct={onAct} />) })
    return { host, onAct }
}

test('offers a newer vendor version with one button', () => {
    const { host, onAct } = mount({})
    expect(host.textContent).toContain('Version 2.5.2')
    expect(host.textContent).toContain('Version 2.5.3 is available.')
    act(() => { host.querySelector<HTMLButtonElement>('button[aria-label="Update: Kimi Code"]')!.click() })
    expect(onAct).toHaveBeenCalledWith({ action: 'update', tool: 'kimi-code' })
})

test('says a ready version waits for the running coworkers, with nothing to press', () => {
    const { host } = mount({ state: 'waiting', pending: '2.5.3' })
    expect(host.textContent).toContain('Version 2.5.3 is ready. It takes over when the running coworkers finish.')
    expect(host.querySelector('button')).toBeNull()
})

test('an updated tool can go back to the built-in copy', () => {
    const { host, onAct } = mount({ state: 'current', current: '2.5.3', source: 'updated' })
    expect(host.textContent).toContain('Version 2.5.3 · updated in this app')
    act(() => { host.querySelector<HTMLButtonElement>('button[aria-label="Use built-in: Kimi Code"]')!.click() })
    expect(onAct).toHaveBeenCalledWith({ action: 'revert', tool: 'kimi-code' })
})

test('a failed update says why and can be tried again; an untested version has no button', () => {
    const failed = mount({ state: 'failed', error: 'verification' })
    expect(failed.host.querySelector('[role=alert]')!.textContent).toBe('The download did not pass its checks, so it was not installed.')
    expect(failed.host.querySelector('button')!.textContent).toBe('Try again')
    const untested = mount({ tool: 'claude', state: 'untested', latest: '2.2.0' })
    expect(untested.host.textContent).toContain('Version 2.2.0 is out but not yet tested with this app.')
    expect(untested.host.querySelector('button')).toBeNull()
})
