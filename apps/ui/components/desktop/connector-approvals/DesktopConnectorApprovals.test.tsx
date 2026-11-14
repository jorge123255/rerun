// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { connectorAnswerText, DesktopConnectorApprovals } from './DesktopConnectorApprovals'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []
afterEach(() => { for (const root of roots.splice(0)) act(() => { root.unmount() }); document.body.innerHTML = ''; vi.unstubAllGlobals() })

const ID = '11111111-1111-4111-8111-111111111111', RULE = '22222222-2222-4222-8222-222222222222'
const pending = [{ id: ID, tool: 'gmail_send_email', kind: 'send', preview: '{"to":"pat@example.test"}', createdAt: '2026-11-14T12:00:00.000Z' }]

async function mount(views: unknown[], generating = false) {
    const calls: { url: string; body?: unknown }[] = []
    let view = views[0]
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) })
        if (init?.method === 'POST') {
            view = views[Math.min(views.length - 1, 1)]
            const body = JSON.parse(String(init.body))
            return Response.json(body.action === 'decide' ? { tool: 'gmail_send_email', kind: 'send', decision: body.decision } : { ok: true })
        }
        return Response.json(view)
    }))
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    roots.push(root)
    const onAnswered = vi.fn()
    await act(async () => { root.render(<DesktopConnectorApprovals sessionId="chat 1" generating={generating} disabled={false} onAnswered={onAnswered} />) })
    await act(async () => { await Promise.resolve() })
    return { host, calls, onAnswered }
}
const button = (host: HTMLElement, text: string) => [...host.querySelectorAll('button')].find(node => node.textContent === text)!

test('shows nothing while no action is waiting and nothing is allowed', async () => {
    const { host, calls } = await mount([{ pending: [], rules: [] }])
    expect(host.textContent).toBe('')
    expect(calls[0]!.url).toBe('/api/desktop/sessions/chat%201/connector-approvals')
})

test('asks about a held action and tells the coworker the answer', async () => {
    const { host, calls, onAnswered } = await mount([{ pending, rules: [] }, { pending: [], rules: [{ id: RULE, tool: 'gmail_send_email', scope: 'conversation' }] }])
    expect(host.textContent).toContain('Allow Gmail Send Email?')
    expect(host.textContent).toContain('This sends something to other people.')
    expect(host.textContent).toContain('pat@example.test')
    expect([...host.querySelectorAll('section button')].map(node => node.textContent)).toEqual(['Allow once', 'Allow for this conversation', 'Always allow', 'Deny'])

    await act(async () => { button(host, 'Allow for this conversation').click() })
    await act(async () => { await Promise.resolve() })
    expect(calls.find(call => call.body)!.body).toEqual({ action: 'decide', id: ID, decision: 'conversation' })
    expect(onAnswered).toHaveBeenCalledWith('Allowed: Gmail Send Email. Run it now with exactly the same arguments.')
    expect(host.querySelector('section')).toBeNull()
    expect(host.textContent).toContain('Allowed without asking')
    expect(host.textContent).toContain('Gmail Send Email · this conversation')

    await act(async () => { button(host, 'Turn off').click() })
    await act(async () => { await Promise.resolve() })
    expect(calls.filter(call => call.body).at(-1)!.body).toEqual({ action: 'forget', ruleId: RULE })
    expect(onAnswered).toHaveBeenCalledTimes(1)
})

test('cannot be answered while the coworker is still replying', async () => {
    const { host } = await mount([{ pending, rules: [] }], true)
    for (const node of host.querySelectorAll<HTMLButtonElement>('section button')) expect(node.disabled).toBe(true)
})

test('a refusal is worded as a refusal', () => {
    expect(connectorAnswerText('drive_delete_file', 'deny')).toBe('Declined: Drive Delete File. Do not run it.')
})
