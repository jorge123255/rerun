// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { ServiceOAuthDriver } from '@/lib/desktop/service-oauth-client'
import { DesktopServiceOAuthConnect } from './DesktopServiceOAuthConnect'
import type { DesktopServiceOAuthSnapshot } from '@rerun/contracts'
const roots: Root[] = []
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterEach(async () => { await act(async () => { roots.splice(0).forEach(root => root.unmount()) }); document.body.innerHTML = '' })
const snapshot: DesktopServiceOAuthSnapshot = { attemptId:'00000000-0000-4000-8000-000000000001',revision:'00000000-0000-4000-8000-000000000002',coworkerId:'owner',installationId:'00000000-0000-4000-8000-000000000003',accountKey:'fixture@abc123',label:'Fixture 2',methodId:'oauth',configGeneration:'00000000-0000-4000-8000-000000000004',state:'configured',expiresAt:300000,configured:false,installed:false,message:'Configuration saved. Connect to sign in.' }
async function mount() { const host = document.createElement('div'); document.body.append(host); const root = createRoot(host); roots.push(root); return { root, host } }
it('does not sign in on mount and requires explicit Connect', async () => {
    const action = vi.fn<ServiceOAuthDriver['action']>(async () => ({ ...snapshot,state:'waiting',message:'Waiting for authorization…' }))
    const { root, host } = await mount()
    await act(async () => root.render(<DesktopServiceOAuthConnect snapshot={snapshot} driver={{ action }} />))
    expect(action).not.toHaveBeenCalled()
    await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Connect')!.click())
    expect(action).toHaveBeenCalledTimes(1)
    expect(action.mock.calls[0]?.[1]).toMatchObject({ action:'start', accountKey:'fixture@abc123', expectedGeneration:snapshot.configGeneration })
})
it('does not display a late sign-in result after the selected coworker changes', async () => {
    let resolve!: (value: DesktopServiceOAuthSnapshot) => void
    const action = vi.fn<ServiceOAuthDriver['action']>(() => new Promise<DesktopServiceOAuthSnapshot>(r => { resolve = r })), changed = vi.fn()
    const { root, host } = await mount(), driver = { action }
    await act(async () => root.render(<DesktopServiceOAuthConnect snapshot={snapshot} driver={driver} onChanged={changed} />))
    await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Connect')!.click())
    await act(async () => root.render(<DesktopServiceOAuthConnect snapshot={{ ...snapshot,coworkerId:'other' }} driver={driver} onChanged={changed} />))
    await act(async () => resolve({ ...snapshot,state:'connected',installed:true,message:'Connected' }))
    expect(changed).not.toHaveBeenCalled()
})
