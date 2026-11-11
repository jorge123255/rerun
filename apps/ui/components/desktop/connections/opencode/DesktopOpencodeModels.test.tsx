// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopOpencodeModel, DesktopOpencodeRefresh } from '@rerun/contracts'
import { DesktopOpencodeModels } from './DesktopOpencodeModels'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = '' })

const model = (id: string, label = id): DesktopOpencodeModel => ({
    id, upstreamId: id.split('/').slice(1).join('/'), plan: id.startsWith('go/') ? 'go' : 'console', label, wire: 'chat', baseUrl: 'https://opencode.ai/inference/go/openai/v1', contextWindow: 1000, outputLimit: 100, images: false, reasoning: true,
    price: { input: 0.5, output: 1.5, cacheRead: null },
})
const catalog = (models: DesktopOpencodeModel[], source: DesktopOpencodeRefresh['source'] = 'live'): DesktopOpencodeRefresh => ({ workspaceId: 1, requestId: 'read', revision: 'rev-1', source, fresh: source === 'live', capturedAt: source === 'snapshot' ? null : '2026-11-06T00:00:00.000Z', selectedModelId: 'go/deepseek-v4-pro', selectedPreserved: true, retiredModelIds: [], models })

async function mount(props: Partial<Parameters<typeof DesktopOpencodeModels>[0]> = {}) {
    const onModelsChange = vi.fn()
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<DesktopOpencodeModels
        catalog={catalog([model('go/deepseek-v4-pro', 'DeepSeek V4 Pro'), model('go/kimi-k3', 'Kimi K3'), model('console/gpt-5', 'GPT-5')])}
        enabledModelIds={['go/deepseek-v4-pro']} defaultModelId="go/deepseek-v4-pro" consoleEnabled={false}
        onModelsChange={onModelsChange} {...props}
    />))
    return onModelsChange
}
async function click(label: string) {
    const element = [...document.querySelectorAll<HTMLElement>('button,[role="switch"]')].find(item => item.getAttribute('aria-label') === label || item.textContent?.includes(label))
    expect(element, label).toBeTruthy()
    await act(async () => element!.click())
}

it('protects the default model and requires explicit Console opt-in', async () => {
    const onModelsChange = await mount()
    expect(document.body.textContent).toContain('Paid by your Go plan.')
    expect(document.body.textContent).toContain('Billed per token, off until you switch one on.')
    expect(document.body.textContent).not.toMatch(/\b\d+ of \d+ on\b/)
    const defaultToggle = document.querySelector('[aria-label="Turn off DeepSeek V4 Pro"]')
    expect(defaultToggle).toHaveProperty('disabled', true)
    expect(document.querySelector('[aria-label="Turn on GPT-5"]')).toHaveProperty('disabled', true)
    await click('Use OpenCode Console credits')
    expect(onModelsChange).toHaveBeenCalledWith({ enabledModelIds: ['go/deepseek-v4-pro', 'console/gpt-5'], consoleEnabled: true })
    await click('Turn on Kimi K3')
    expect(onModelsChange).toHaveBeenCalledWith({ enabledModelIds: ['go/deepseek-v4-pro', 'go/kimi-k3'], consoleEnabled: false })
})

it('keeps retired selected models visible for removal and filters both plans', async () => {
    const onModelsChange = await mount({ catalog: catalog([model('go/deepseek-v4-pro', 'DeepSeek V4 Pro'), model('go/kimi-k3', 'Kimi K3'), model('console/gpt-5', 'GPT-5')]), enabledModelIds: ['go/deepseek-v4-pro', 'go/retired'], defaultModelId: 'go/deepseek-v4-pro' })
    expect(document.body.textContent).toContain('go/retired')
    expect(document.body.textContent).toContain('No longer offered by OpenCode')
    expect(document.body.textContent).toContain('Kimi K3')
    await click('Turn off go/retired')
    expect(onModelsChange).toHaveBeenCalledWith({ enabledModelIds: ['go/deepseek-v4-pro'], consoleEnabled: false })
    const search = document.querySelector<HTMLInputElement>('input[aria-label="Search models"]')!
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'gpt-5')
        search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(document.body.textContent).toContain('Console, paid with your credits')
    expect(document.body.textContent).toContain('GPT-5')
    expect(document.body.textContent).not.toContain('DeepSeek V4 Pro')
    expect(document.body.textContent).not.toContain('Kimi K3')
})
