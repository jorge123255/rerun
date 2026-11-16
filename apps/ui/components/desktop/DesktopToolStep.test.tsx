// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { DynamicToolUIPart } from 'ai'
import { expect, test } from 'vitest'
import { buildDesktopConnectorApps, type DesktopConnectorApps } from '@/lib/desktop/connector-apps'
import { DesktopToolStep } from './DesktopToolStep'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
async function mount(part: DynamicToolUIPart, connectors?: DesktopConnectorApps, restored = true) {
    const container = document.body.appendChild(document.createElement('div'))
    const root = createRoot(container)
    await act(async () => { root.render(<DesktopToolStep part={part} restored={restored} connectors={connectors} />) })
    return { container, async close() { await act(async () => root.unmount()); container.remove() } }
}

test('a lost saved acknowledgement is Unknown instead of a running or completed step', async () => {
    const part: DynamicToolUIPart & { acknowledgement: string } = { type: 'dynamic-tool', toolName: 'fs_read', toolCallId: 'lost-call', state: 'output-available', input: { path: 'note.md' }, output: 'fixture', acknowledgement: 'lost' }
    const view = await mount(part)
    try {
        expect(view.container.textContent).toContain('unknown')
        await act(async () => { view.container.querySelector('button')!.click() })
        expect(view.container.querySelector('[data-status="unknown"]')).not.toBeNull()
        expect(view.container.querySelector('[data-status="running"]')).toBeNull()
    } finally { await view.close() }
})

test('restored preview markers cannot bypass client credential redaction', async () => {
    const secret = 'sk-ABCDEFGHIJKLMNOPQRSTUVWX'
    const part: DynamicToolUIPart & { desktopPreview: true } = { type: 'dynamic-tool', toolName: 'fs_read', toolCallId: 'saved-call', state: 'output-available', input: { preview: secret }, output: secret, desktopPreview: true }
    const view = await mount(part)
    try {
        await act(async () => { view.container.querySelector('button')!.click() })
        expect(view.container.textContent).not.toContain(secret)
        expect(view.container.textContent).toContain('[redacted]')
    } finally { await view.close() }
})

test('a reopened and a live step of the coworker’s app both show its logo and name; without the app the row is unchanged', async () => {
    const connectors = buildDesktopConnectorApps({ agentId: 'agent', servers: [{ server: 'linear', slug: 'linear', name: 'Linear', icon: '/services/linear.svg', category: 'productivity' }], toolkits: [] })
    const part: DynamicToolUIPart = { type: 'dynamic-tool', toolName: 'linear_create_issue', toolCallId: 'call-app', state: 'output-available', input: { title: 'Fix it' }, output: 'done' }
    for (const restored of [true, false]) {
        const view = await mount(part, connectors, restored)
        try {
            expect(view.container.querySelector('img')?.getAttribute('src')).toBe('/services/linear.svg')
            expect(view.container.textContent).toContain('Create Issue')
        } finally { await view.close() }
    }
    const withApps = await mount({ ...part, toolName: 'fs_read', toolCallId: 'call-plain', input: { path: 'note.md' } }, connectors, false)
    const without = await mount({ ...part, toolName: 'fs_read', toolCallId: 'call-plain', input: { path: 'note.md' } }, undefined, false)
    try {
        expect(withApps.container.querySelector('img')).toBeNull()
        expect(withApps.container.innerHTML).toBe(without.container.innerHTML)
    } finally { await withApps.close(); await without.close() }
})
