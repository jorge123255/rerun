// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { DesktopManagedApps } from './DesktopManagedApps'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []
afterEach(() => { for (const root of roots.splice(0)) act(() => { root.unmount() }); document.body.innerHTML = ''; vi.unstubAllGlobals() })
const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const apps = [{ slug: 'gmail', name: 'Gmail', summary: 'Read and send email' }, { slug: 'outlook', name: 'Outlook', summary: 'Microsoft mail' }]
const coworkers = [{ id: 'c1', name: 'Pat' }, { id: 'c2', name: 'Sam' }]

async function mount(first: unknown, answers: Record<string, { status?: number; body: unknown }> = {}) {
    const posts: unknown[] = []
    const opened = vi.fn(), vaultChanged = vi.fn()
    vi.stubGlobal('open', opened)
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method !== 'POST') return Response.json(first)
        const body = JSON.parse(String(init.body)); posts.push(body)
        const answer = answers[body.action] ?? { body: { view: first } }
        return Response.json(answer.body, { status: answer.status ?? 200 })
    }))
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    roots.push(root)
    await act(async () => { root.render(<DesktopManagedApps coworkers={coworkers} onVaultChanged={vaultChanged} />) })
    await act(async () => { await Promise.resolve() })
    return { host, posts, opened, vaultChanged }
}
const press = async (host: HTMLElement, label: string) => {
    await act(async () => { [...host.querySelectorAll('button')].find(node => (node.getAttribute('aria-label') ?? node.textContent) === label)!.click() })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
}
function type(input: HTMLInputElement, value: string) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
}

test('without a key it says where the sign-ins are held and takes the key, masked', async () => {
    const { host, posts } = await mount({ configured: false, apps, accounts: [] }, { 'set-key': { status: 400, body: { error: 'Composio refused this key.' } } })
    expect(host.textContent).toContain('Your sign-in to each app is held by Composio, not on this Mac')
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Composio key"]')!
    expect(input.type).toBe('password')
    expect([...host.querySelectorAll('button')].find(node => node.textContent === 'Save key')!.disabled).toBe(true)
    await act(async () => { type(input, 'wrong-key-000000') })
    await press(host, 'Save key')
    expect(posts).toEqual([{ action: 'set-key', key: 'wrong-key-000000' }])
    expect(host.querySelector('[role=alert]')!.textContent).toBe('Composio refused this key.')
    expect([...host.querySelectorAll('button')].some(node => node.textContent === 'Connect')).toBe(false)
})

test('with a key: connect opens the sign-in page, a signed-in account is given to coworkers', async () => {
    const pending = { configured: true, apps, accounts: [{ id: ACCOUNT, slug: 'gmail', name: 'Gmail', status: 'pending', agentIds: [] }] }
    const active = { ...pending, accounts: [{ ...pending.accounts[0], status: 'active' }] }
    const { host, posts, opened } = await mount({ configured: true, apps, accounts: [] }, {
        connect: { body: { view: pending, signIn: 'https://connect.composio.example/link/ca_1' } },
        refresh: { body: { view: active } },
        attach: { body: { view: { ...active, accounts: [{ ...active.accounts[0], agentIds: ['c2'] }] } } },
    })
    expect([...host.querySelectorAll('li p:first-child')].map(node => node.textContent)).toEqual(['Gmail', 'Outlook'])
    await press(host, 'Connect Gmail')
    expect(opened).toHaveBeenCalledWith('https://connect.composio.example/link/ca_1', '_blank', 'noopener,noreferrer')
    expect(host.textContent).toContain('Waiting for you to finish signing in in your browser')
    expect([...host.querySelectorAll('li p:first-child')].map(node => node.textContent)).toEqual(['Outlook'])
    expect(host.querySelector('input[type=checkbox]')).toBeNull()

    await press(host, 'Check sign-in')
    expect(host.textContent).toContain('Signed in')
    const boxes = [...host.querySelectorAll<HTMLInputElement>('input[type=checkbox]')]
    expect(boxes.map(box => box.checked)).toEqual([false, false])
    await act(async () => { boxes[1]!.click() })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(posts.at(-1)).toEqual({ action: 'attach', id: ACCOUNT, agentId: 'c2', attached: true })
    expect([...host.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].map(box => box.checked)).toEqual([false, true])
})

test('a large account shows the first matches and search finds the rest', async () => {
    const many = Array.from({ length: 300 }, (_unused, index) => ({ slug: `app${index}`, name: `App ${index}`, summary: index === 250 ? 'Invoices and billing' : 'Something else' }))
    const { host } = await mount({ configured: true, apps: many, accounts: [] })
    expect(host.textContent).toContain('Every app in your Composio account: 300 to choose from.')
    expect(host.querySelectorAll('li').length).toBe(40)
    expect(host.textContent).toContain('Showing 40 of 300. Search to find the others.')
    await act(async () => { type(host.querySelector<HTMLInputElement>('input[aria-label="Search managed apps"]')!, 'billing') })
    expect([...host.querySelectorAll('li p:first-child')].map(node => node.textContent)).toEqual(['App 250'])
    expect(host.textContent).not.toContain('Showing 40')
})

test('a Composio Connect key becomes a Vault connector and the Vault list is read again', async () => {
    const empty = { configured: false, apps, accounts: [] }
    const { host, vaultChanged } = await mount(empty, { 'set-key': { body: { view: empty, addedToVault: 'composio' } } })
    expect(host.textContent).toContain('A Composio Connect key (it starts with ck_) works here too.')
    await act(async () => { type(host.querySelector<HTMLInputElement>('input[aria-label="Composio key"]')!, 'ck_fixture_0000000000') })
    await press(host, 'Save key')
    expect(vaultChanged).toHaveBeenCalledTimes(1)
    expect(host.querySelector('[role=status]')!.textContent).toContain('Composio was added to the Vault as “composio”.')
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Composio key"]')!.value).toBe('')
})

test('with Composio kept in the Vault: apps connect here, coworkers are chosen on the Vault entry', async () => {
    const view = { configured: true, connector: 'composio', apps, accounts: [{ id: ACCOUNT, slug: 'gmail', name: 'Gmail', status: 'pending', agentIds: [] }] }
    const { host, posts, opened } = await mount(view, {
        connect: { body: { view, signIn: 'https://connect.composio.dev/link/lk_1' } },
        refresh: { body: { view: { ...view, accounts: [{ ...view.accounts[0], status: 'active' }] }, signIn: 'https://connect.composio.dev/link/lk_2' } },
    })
    expect(host.textContent).toContain('Coworkers given “composio” in the list above can then use it.')
    expect(host.textContent).not.toContain('Remove the Composio key')
    await press(host, 'Connect Outlook')
    expect(opened).toHaveBeenCalledWith('https://connect.composio.dev/link/lk_1', '_blank', 'noopener,noreferrer')
    await press(host, 'Open sign-in again')
    expect(posts.at(-1)).toEqual({ action: 'refresh', id: ACCOUNT, retry: true })
    // Signed in: no coworker boxes, and removing is only from this list.
    expect(host.querySelector('input[type="checkbox"]')).toBeNull()
    expect(host.textContent).toContain('Coworkers given “composio” can use it.')
    expect(host.textContent).toContain('Remove from list')
})
