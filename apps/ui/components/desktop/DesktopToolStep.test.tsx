// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { DynamicToolUIPart } from 'ai'
import { expect, test } from 'vitest'
import { DesktopToolStep } from './DesktopToolStep'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
async function mount(part: DynamicToolUIPart) {
    const container = document.body.appendChild(document.createElement('div'))
    const root = createRoot(container)
    await act(async () => { root.render(<DesktopToolStep part={part} restored />) })
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
