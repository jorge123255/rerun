// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { DESKTOP_OPENCODE_CONNECTION_ID, DESKTOP_OPENCODE_SNAPSHOT, type DesktopOpencodeConnectionChange } from '@rerun/contracts'
import { DesktopOpencodeSettings } from './DesktopOpencodeSettings'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('mounts the saved Settings connection and explicitly enables a free Go model', async () => {
    const view = {
        connectionId: DESKTOP_OPENCODE_CONNECTION_ID, workspaceId: 1, name: 'OpenCode',
        revision: '5a0ea2a3-d2f4-412a-abd8-b111d771c75f', defaultModelId: 'go/deepseek-v4-pro',
        enabledModelIds: ['go/deepseek-v4-pro'], consoleEnabled: false,
    }
    let connection: typeof view | null = null
    const changes: DesktopOpencodeConnectionChange[] = []
    vi.stubGlobal('fetch', vi.fn(async (path: string, options?: RequestInit) => {
        if (path === '/api/desktop/settings') return Response.json({ connections: [], default: null })
        if (!options?.body) return Response.json({ connection })
        const input = JSON.parse(String(options.body))
        if (input.action === 'catalog') return Response.json({ ...input, action: undefined, revision: 'snapshot', source: 'snapshot',
            fresh: false, capturedAt: null, selectedPreserved: true, retiredModelIds: [], models: DESKTOP_OPENCODE_SNAPSHOT })
        if (input.action === 'usage') return Response.json({ windows: [], capturedAt: null, fresh: false })
        changes.push(input)
        if (input.action === 'key') connection = view
        if (input.action === 'models') connection = { ...view, revision: '6a0ea2a3-d2f4-412a-abd8-b111d771c75f', enabledModelIds: input.enabledModelIds }
        return Response.json({ connection })
    }))
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    const onProviders = vi.fn()
    try {
        await act(async () => root.render(<DesktopOpencodeSettings workspaceId={1} rejected={false} onProviders={onProviders} onBack={() => {}} />))
        const key = host.querySelector<HTMLInputElement>('input[type=password]')!
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(key, 'oc_sk_synthetic')
            key.dispatchEvent(new Event('input', { bubbles: true }))
        })
        await act(async () => [...host.querySelectorAll('button')].find(item => item.textContent === 'Connect')!.click())
        expect(changes[0]).toMatchObject({ action: 'key', expectedRevision: null, workspaceId: 1 })
        const free = host.querySelector<HTMLButtonElement>('[aria-label="Turn on Beam Free"]')!
        expect(free.disabled).toBe(false)
        await act(async () => free.click())
        expect(changes[1]).toEqual({ action: 'models', expectedRevision: view.revision, workspaceId: 1,
            enabledModelIds: ['go/deepseek-v4-pro', 'go/beam-free'], defaultModelId: 'go/deepseek-v4-pro', consoleEnabled: false })
        expect(host.querySelector('[aria-label="Turn off Beam Free"]')).toBeTruthy()
        expect(host.textContent).not.toContain('oc_sk_synthetic')
    } finally {
        await act(async () => root.unmount())
        host.remove()
        vi.unstubAllGlobals()
    }
})
