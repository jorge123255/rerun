// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopOpencodeConnectionSnapshot, DesktopOpencodeDriver } from '@/lib/desktop/opencode/driver'
import { DesktopOpencodeConnection } from './DesktopOpencodeConnection'

let root: Root | undefined
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ''; vi.restoreAllMocks() })

const connection = (revision = 'rev-1'): DesktopOpencodeConnectionSnapshot => ({
    workspaceId: 1, owner: 'OpenCode', connectionId: 'oc-1', connectionRevision: revision, apiKey: 'oc_sk_masked', consoleEnabled: false, enabledModelIds: ['go/deepseek-v4-pro'], defaultModelId: 'go/deepseek-v4-pro', state: 'active', launchNonce: 'launch-1',
})

function driver(overrides: Partial<DesktopOpencodeDriver> = {}): DesktopOpencodeDriver {
    return {
        snapshot: vi.fn(async () => connection()),
        prepare: vi.fn(async () => ({ ok: true as const })),
        catalog: vi.fn(async () => ({ workspaceId: 1, requestId: 'read', revision: 'snapshot', source: 'snapshot' as const, fresh: false, capturedAt: null, selectedModelId: 'go/deepseek-v4-pro', selectedPreserved: true, retiredModelIds: [], models: [] })),
        refresh: vi.fn(async () => ({ workspaceId: 1, requestId: 'refresh', revision: 'live-1', source: 'live' as const, fresh: true, capturedAt: '2026-11-06T00:00:00.000Z', selectedModelId: 'go/deepseek-v4-pro', selectedPreserved: true, retiredModelIds: [], models: [] })),
        usage: vi.fn(async () => ({ windows: [], capturedAt: null, fresh: false })),
        enable: vi.fn(async () => ({ ok: true as const })),
        disconnect: vi.fn(async () => ({ ok: true as const })),
        ...overrides,
    }
}
const callbacks = () => ({ onSave: vi.fn(async () => {}), onProviders: vi.fn(async () => {}), onRename: vi.fn(async () => {}), onDisconnect: vi.fn(async () => {}), onBack: vi.fn() })
async function mount(driverValue: DesktopOpencodeDriver, props: Partial<Parameters<typeof DesktopOpencodeConnection>[0]> = {}) {
    const ports = callbacks()
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<DesktopOpencodeConnection workspaceId={1} connection={connection()} driver={driverValue} {...ports} {...props} />))
    return ports
}
async function input(label: string, value: string) {
    const field = [...document.querySelectorAll<HTMLInputElement>('input')].find(item => item.getAttribute('aria-label') === label || item.placeholder === label)
    expect(field, label).toBeTruthy()
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
        field!.dispatchEvent(new Event('input', { bubbles: true }))
    })
}
async function click(label: string) {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.includes(label) || item.getAttribute('aria-label') === label)
    expect(button, label).toBeTruthy()
    await act(async () => button!.click())
}
async function clickExact(label: string) {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === label)
    expect(button, label).toBeTruthy()
    await act(async () => button!.click())
}

it('rejects an invalid credential without saving or reporting a connection', async () => {
    const value = driver({ prepare: async () => ({ ok: false as const, problem: 'OpenCode keys start with oc_sk_.' }) })
    const ports = await mount(value)
    await input('API key', 'sk-not-opencode')
    await click('Save key')
    expect(ports.onSave).not.toHaveBeenCalled()
    expect(ports.onProviders).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('OpenCode keys start with oc_sk_.')
    expect(document.body.textContent).not.toContain('OpenCode connected.')
})

it('does not report connected when the canonical save fails, then reconnects with a masked key', async () => {
    const value = driver()
    const ports = await mount(value, { rejected: true, onSave: vi.fn(async () => { throw new Error('Key rejected') }) })
    expect(document.body.textContent).toContain('This key was rejected')
    await input('API key', 'oc_sk_new')
    await click('Save key')
    expect(document.body.textContent).toContain('Key rejected')
    expect(document.body.textContent).not.toContain('OpenCode connected.')
})

it('cancels a dirty form without effects and discards only on confirmation', async () => {
    const value = driver()
    const ports = await mount(value)
    await input('API key', 'oc_sk_dirty')
    await click('Back to AI providers')
    expect(document.body.textContent).toContain('Discard changes?')
    await click('Cancel')
    expect(ports.onBack).not.toHaveBeenCalled()
    await click('Back to AI providers')
    await click('Discard')
    expect(ports.onBack).toHaveBeenCalledTimes(1)
    expect(ports.onSave).not.toHaveBeenCalled()
})

it('ignores a stale catalog response after the connection revision changes', async () => {
    let resolveOld!: (value: unknown) => void
    const value = driver({ refresh: vi.fn(async () => new Promise<any>(resolve => { resolveOld = resolve })) })
    await mount(value)
    await click('Refresh models')
    const next = connection('rev-2')
    await act(async () => root!.render(<DesktopOpencodeConnection workspaceId={1} connection={next} driver={value} {...callbacks()} />))
    await act(async () => resolveOld({ workspaceId: 1, requestId: 'old', revision: 'old-live', source: 'live', fresh: true, capturedAt: null, selectedModelId: 'old/model', selectedPreserved: false, retiredModelIds: [], models: [{ id: 'go/old-model', upstreamId: 'old-model', plan: 'go', label: 'Old model', wire: 'chat', baseUrl: 'https://opencode.ai/inference/go/openai/v1', contextWindow: 1, outputLimit: 1, images: false, reasoning: false, price: { input: 1, output: 2, cacheRead: null } }] }))
    expect(document.body.textContent).not.toContain('Old model')
})

it('disconnects only after confirmation and preserves the connection on failure', async () => {
    const ports = await mount(driver(), { onDisconnect: vi.fn(async () => { throw new Error('Disconnect failed') }) })
    await click('Remove OpenCode')
    await clickExact('Remove')
    expect(ports.onDisconnect).toHaveBeenCalledWith('oc-1', 'rev-1')
    expect(ports.onBack).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Disconnect failed')
})
