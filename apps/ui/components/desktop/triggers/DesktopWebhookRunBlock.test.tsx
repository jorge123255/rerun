// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { DesktopWebhookRunBlock } from './DesktopWebhookRunBlock'
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = '' })
it('keeps the original webhook divider and opens the captured payload', async () => {
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    await act(async () => root!.render(<DesktopWebhookRunBlock agentId="a1" payload={{ prompt: 'Handle refund', slug: 'stripe', method: 'POST', receivedAt: '2026-11-05T12:00:00.000Z', bytes: 12, truncated: false, body: '{"ok":true}', isJson: true, contentType: 'application/json' }} />))
    expect(container.textContent).toContain('Webhook received'); expect(container.textContent).toContain('stripe')
    const button = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('View payload'))!
    expect(button).toBeTruthy(); await act(async () => button.click())
    expect(document.body.textContent).toContain('Payload'); expect(document.body.textContent).toContain('"ok"')
})
