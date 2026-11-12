// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { DesktopMacSettings } from './DesktopMacSettings'
import type { MacUpdateState } from './DesktopMacUpdateBridge'

type DesktopLoginWriter = (enabled: boolean) => Promise<{ openAtLogin: boolean; version: string; updatesAvailable: boolean }>

async function fixture(appStoreBuild: boolean) {
    let reportUpdate: (state: MacUpdateState) => void = () => {}
    const saved = { openAtLogin: false, version: '1.0.0', updatesAvailable: true }
    const macSettings = {
        read: vi.fn(async () => saved),
        setOpenAtLogin: vi.fn<DesktopLoginWriter>(async () => saved),
    }
    const stop = vi.fn()
    const updates = {
        getState: vi.fn(async () => ({ status: 'idle' })),
        onState: vi.fn((listener: typeof reportUpdate) => { reportUpdate = listener; return stop }),
        check: vi.fn(async () => { reportUpdate({ status: 'checking' }) }),
        install: vi.fn(async () => false),
    }
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('desktopApp', { macSettings, updates })
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    await act(async () => root.render(<DesktopMacSettings appStoreBuild={appStoreBuild} />))
    return {
        host, macSettings, updates, stop, reportUpdate,
        button: () => host.querySelector<HTMLButtonElement>('button:not([role="switch"])')!,
        async close() {
            await act(async () => root.unmount())
            host.remove()
            vi.unstubAllGlobals()
        },
    }
}

it('uses the OS readback and follows update events through check and restart', async () => {
    const view = await fixture(false)
    try {
        const login = view.host.querySelector<HTMLButtonElement>('#desktop-open-at-login')!
        await act(async () => login.click())
        expect(view.macSettings.setOpenAtLogin).toHaveBeenCalledExactlyOnceWith(true)
        expect(login.getAttribute('aria-checked')).toBe('false')
        expect(view.host.textContent).toContain('Could not change Open at login.')
        expect(view.host.textContent).toContain('Rerun 1.0.0')

        await act(async () => view.button().click())
        expect(view.updates.check).toHaveBeenCalledTimes(1)
        expect(view.button().disabled).toBe(true)
        expect(view.host.textContent).toContain('Checking for updates')
        await act(async () => view.reportUpdate({ status: 'ready', version: '1.1.0' }))
        expect(view.button().textContent).toBe('Restart to update')
        await act(async () => view.button().click())
        expect(view.updates.install).toHaveBeenCalledTimes(1)
        expect(view.host.textContent).toContain('Could not restart to install the update.')
    } finally { await view.close() }
    expect(view.stop).toHaveBeenCalledTimes(1)
})

it('leaves update checks to the App Store without invoking the direct updater', async () => {
    const view = await fixture(true)
    try {
        expect(view.host.textContent).toContain('Updates are managed by the App Store.')
        expect(view.button()).toBeNull()
        expect(view.updates.getState).not.toHaveBeenCalled()
        expect(view.updates.onState).not.toHaveBeenCalled()
    } finally { await view.close() }
})
