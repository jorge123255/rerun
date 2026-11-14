// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { DesktopConnectorRules } from './DesktopConnectorRules'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []
afterEach(() => { for (const root of roots.splice(0)) act(() => { root.unmount() }); document.body.innerHTML = ''; vi.unstubAllGlobals() })
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222'

async function mount(rules: unknown[]) {
    const calls: { url: string; method: string; body?: unknown }[] = []
    let current = rules
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method ?? 'GET', ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) })
        if (init?.method === 'DELETE') current = current.filter(rule => (rule as { id: string }).id !== JSON.parse(String(init.body)).ruleId)
        return Response.json({ rules: current })
    }))
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    roots.push(root)
    await act(async () => { root.render(<DesktopConnectorRules agentId="coworker 1" />) })
    await act(async () => { await Promise.resolve() })
    return { host, calls }
}

test('shows nothing for a coworker that asks about everything', async () => {
    const { host, calls } = await mount([])
    expect(host.textContent).toBe('')
    expect(calls[0]).toEqual({ url: '/api/desktop/agents/coworker%201/connector-approvals', method: 'GET' })
})

test('lists what runs without asking and turns one off', async () => {
    const { host, calls } = await mount([{ id: A, tool: 'gmail_send_email', scope: 'always' }, { id: B, tool: 'drive_delete_file', scope: 'conversation' }])
    expect(host.textContent).toContain('Allowed without asking')
    expect([...host.querySelectorAll('li span')].map(node => node.textContent)).toEqual(['Gmail Send Email · always', 'Drive Delete File · this conversation'])
    await act(async () => { host.querySelector<HTMLButtonElement>('li button')!.click() })
    await act(async () => { await Promise.resolve() })
    expect(calls.at(-1)).toEqual({ url: '/api/desktop/agents/coworker%201/connector-approvals', method: 'DELETE', body: { ruleId: A } })
    expect([...host.querySelectorAll('li span')].map(node => node.textContent)).toEqual(['Drive Delete File · this conversation'])
})
