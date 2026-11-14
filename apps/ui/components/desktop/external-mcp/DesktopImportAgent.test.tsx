// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { DesktopImportAgent } from './DesktopImportAgent'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []
afterEach(() => { for (const root of roots.splice(0)) act(() => { root.unmount() }); document.body.innerHTML = ''; vi.unstubAllGlobals() })
function mount(listening = true) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    roots.push(root)
    act(() => { root.render(<DesktopImportAgent workspaceId={1} listening={listening} />) })
    return host
}
const key = { version: 1, keyId: '11111111-1111-4111-8111-111111111111', workspaceId: 1, name: 'Import · Hermes Agent', keyPrefix: 'rk_abcdefghi'.slice(0, 12), scopes: ['mcp:read'], status: 'active', expiresAt: '2026-11-15T12:00:00.000Z', revokedAt: null, createdAt: '2026-11-14T12:00:00.000Z', lastUsedAt: null, revision: 1 }
const press = (host: HTMLElement, label: string) => act(async () => { [...host.querySelectorAll('button')].find(button => button.textContent?.trim() === label)!.click() })

test('offers the agents that can run on this Mac and no hosted connector', () => {
    const host = mount()
    expect([...host.querySelectorAll('[role=radio]')].map(item => item.textContent)).toEqual(['OpenClaw', 'Hermes Agent', 'Other'])
})

test('asks for a key for the chosen source and shows the text once', async () => {
    const fetched = vi.fn(async () => Response.json({ ok: true, key: { ...key, keyPrefix: key.keyPrefix }, prompt: 'Move yourself to Rerun…' }))
    vi.stubGlobal('fetch', fetched)
    const host = mount()
    await press(host, 'Hermes Agent')
    await press(host, 'Create import key')
    const [url, init] = fetched.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/desktop/external-mcp/import')
    expect(JSON.parse(String(init.body))).toMatchObject({ workspaceId: 1, source: 'hermes' })
    expect(host.querySelector('textarea')!.value).toBe('Move yourself to Rerun…')
    expect(host.textContent).toContain('Paste this into Hermes Agent. It is shown once.')
    await press(host, 'Done')
    expect(host.querySelector('textarea')).toBeNull()
})

test('cannot make a key while outside connections are off, and says a refusal in its own words', async () => {
    expect([...mount(false).querySelectorAll('button')].find(button => button.textContent?.trim() === 'Create import key')!.disabled).toBe(true)
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: false, code: 'too_many_keys', message: 'This workspace has too many keys.' }, { status: 409 })))
    const host = mount()
    await press(host, 'Create import key')
    expect(host.querySelector('[role=alert]')!.textContent).toBe('This workspace has too many keys.')
})
