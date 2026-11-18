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
    const opened = vi.fn(), vaultChanged = vi.fn(), chooseCoworkers = vi.fn()
    vi.stubGlobal('open', opened)
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method !== 'POST') return typeof first === 'function' ? first() : Response.json(first)
        const body = JSON.parse(String(init.body)); posts.push(body)
        const answer = answers[body.action] ?? { body: { view: first } }
        return Response.json(answer.body, { status: answer.status ?? 200 })
    }))
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    roots.push(root)
    await act(async () => { root.render(<DesktopManagedApps coworkers={coworkers} onVaultChanged={vaultChanged} onChooseCoworkers={chooseCoworkers} />) })
    await act(async () => { await Promise.resolve() })
    return { host, posts, opened, vaultChanged, chooseCoworkers }
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
    const { host, posts, opened, chooseCoworkers } = await mount(view, {
        connect: { body: { view, signIn: 'https://connect.composio.dev/link/lk_1' } },
        refresh: { body: { view: { ...view, accounts: [{ ...view.accounts[0], status: 'active' }] }, signIn: 'https://connect.composio.dev/link/lk_2' } },
    })
    expect(host.textContent).toContain('all its signed-in apps when their Custom MCP servers permission is on.')
    await press(host, 'Choose coworkers for Composio')
    expect(chooseCoworkers).toHaveBeenCalledWith('composio')
    expect(posts).toEqual([])
    expect(host.textContent).not.toContain('Remove the Composio key')
    await press(host, 'Connect Outlook')
    expect(opened).toHaveBeenCalledWith('https://connect.composio.dev/link/lk_1', '_blank', 'noopener,noreferrer')
    await press(host, 'Open sign-in again')
    expect(posts.at(-1)).toEqual({ action: 'refresh', id: ACCOUNT, retry: true })
    // Signed in: no coworker boxes, and removing is only from this list.
    expect(host.querySelector('input[type="checkbox"]')).toBeNull()
    expect(host.textContent).toContain('Removing this account signs it out at Composio.')
    await press(host, 'Find apps already signed in at Composio')
    expect(posts.at(-1)).toEqual({ action: 'find' })
})

test('a second account of one app is added with a label, and the two are told apart', async () => {
    const SECOND = '22222222-2222-4222-8222-222222222222'
    const one = { configured: true, apps, accounts: [{ id: ACCOUNT, slug: 'gmail', name: 'Gmail', status: 'active', agentIds: [] }] }
    const two = { ...one, accounts: [...one.accounts, { id: SECOND, slug: 'gmail', name: 'Gmail', label: 'Work', status: 'pending', agentIds: [] }] }
    const { host, posts, opened } = await mount(one, { connect: { body: { view: two, signIn: 'https://connect.composio.example/link/ca_2' } } })
    await press(host, 'Add another Gmail account')
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Label for another Gmail account"]')!
    const connect = () => [...host.querySelectorAll<HTMLButtonElement>('form button[type="submit"]')].find(node => node.textContent === 'Connect')!
    expect(connect().disabled).toBe(true)
    await act(async () => { type(input, ' Work ') })
    await act(async () => { connect().click() })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(posts).toEqual([{ action: 'connect', slug: 'gmail', label: 'Work' }])
    expect(opened).toHaveBeenCalledWith('https://connect.composio.example/link/ca_2', '_blank', 'noopener,noreferrer')
    expect([...host.querySelectorAll('[data-managed-account="gmail"] p.font-medium')].map(node => node.textContent)).toEqual(['Gmail', 'Gmail · Work'])
    expect(host.querySelector('button[aria-label="Remove Gmail · Work"]')).not.toBeNull()
    expect(host.querySelector('input[aria-label="Label for another Gmail account"]')).toBeNull()
})

test('an expired account says so and is signed in again from its row, keeping its coworkers', async () => {
    const expired = { configured: true, apps, accounts: [{ id: ACCOUNT, slug: 'gmail', name: 'Gmail', status: 'expired', agentIds: ['c1'] }] }
    const pending = { ...expired, accounts: [{ ...expired.accounts[0], status: 'pending' }] }
    const { host, posts, opened } = await mount(expired, { refresh: { body: { view: pending, signIn: 'https://connect.composio.example/link/ca_2' } } })
    expect(host.textContent).toContain('The sign-in has expired.')
    // Its coworkers are not offered while it is expired.
    expect(host.querySelector('fieldset')).toBeNull()
    await press(host, 'Sign in again')
    expect(posts).toEqual([{ action: 'refresh', id: ACCOUNT, retry: true }])
    expect(opened).toHaveBeenCalledWith('https://connect.composio.example/link/ca_2', '_blank', 'noopener,noreferrer')
    expect(host.textContent).toContain('Waiting for you to finish signing in')
})

test('removing the key says how many accounts are signed out, and offers to remove it anyway when Composio could not be asked', async () => {
    const accounts = [{ id: ACCOUNT, slug: 'gmail', name: 'Gmail', status: 'active', agentIds: [] }, { id: '22222222-2222-4222-8222-222222222222', slug: 'gmail', name: 'Gmail', label: 'Work', status: 'active', agentIds: [] }]
    const kept = { configured: true, apps, accounts, keyRemovalSignsOut: 2 }
    const answers: Record<string, { status?: number; body: unknown }> = { 'remove-key': { body: { view: kept, notSignedOut: ['Gmail', 'Gmail · Work'] } } }
    const { host, posts } = await mount(kept, answers)
    await press(host, 'Remove the Composio key')
    expect(document.body.textContent).toContain('2 accounts this Mac signed in are signed out at Composio first.')
    expect(document.body.textContent).toContain('Nothing else in your Composio account is touched.')

    await press(document.body, 'Remove key')
    expect(posts.at(-1)).toEqual({ action: 'remove-key' })
    // The key was kept: the dialog stays, names the accounts, and the second choice is spelled out.
    expect(document.body.textContent).toContain('The key was kept')
    expect(document.body.textContent).toContain('these accounts are still signed in there: Gmail, Gmail · Work.')
    expect(document.body.textContent).toContain('leave those sign-ins at Composio')
    expect(host.textContent).toContain('Remove the Composio key')

    answers['remove-key'] = { body: { view: { configured: false, apps, accounts: [] } } }
    await press(document.body, 'Remove key anyway')
    expect(posts.at(-1)).toEqual({ action: 'remove-key', leaveSignedIn: true })
    expect(document.body.textContent).not.toContain('The key was kept')
    expect(host.querySelector('input[aria-label="Composio key"]')).not.toBeNull()
})

test('removing the key with one account says one', async () => {
    const one = await mount({ configured: true, apps, accounts: [{ id: ACCOUNT, slug: 'gmail', name: 'Gmail', status: 'active', agentIds: [] }], keyRemovalSignsOut: 1 })
    await press(one.host, 'Remove the Composio key')
    expect(document.body.textContent).toContain('1 account this Mac signed in is signed out at Composio first.')
})

test('removing the key with no account signed in says there is nothing to sign out', async () => {
    const none = await mount({ configured: true, apps, accounts: [], keyRemovalSignsOut: 0 })
    await press(none.host, 'Remove the Composio key')
    expect(document.body.textContent).toContain('No account here has a sign-in at Composio to sign out.')
})


test('allows retrying a failed managed-apps read without asking for the key again', async () => {
    const read = vi.fn().mockResolvedValueOnce(Response.json({ error: 'Service unavailable' }, { status: 503 }))
        .mockResolvedValueOnce(Response.json({ configured: true, apps, accounts: [] }))
    const { host } = await mount(read)
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Could not load managed apps')
    expect(host.querySelector('input[aria-label="Composio key"]')).toBeNull()
    await press(host, 'Retry managed apps')
    expect(host.querySelector('button[aria-label="Connect Gmail"]')).not.toBeNull()
    expect(read).toHaveBeenCalledTimes(2)
})

test('returning from the browser verifies the opened account without starting another login', async () => {
    const other = { id: '22222222-2222-4222-8222-222222222222', slug: 'outlook', name: 'Outlook', status: 'pending', agentIds: [] }
    const gmail = { id: ACCOUNT, slug: 'gmail', name: 'Gmail', status: 'pending', agentIds: [] }
    const first = { configured: true, apps, accounts: [other] }
    const { host, posts, opened } = await mount(first, {
        connect: { body: { view: { ...first, accounts: [other, gmail] }, signIn: 'https://connect.composio.example/link/1' } },
        refresh: { body: { view: { ...first, accounts: [other, { ...gmail, status: 'active' }] } } },
    })
    await press(host, 'Connect Gmail')
    await press(host, 'Open sign-in page')
    expect(posts).toEqual([{ action: 'connect', slug: 'gmail' }])
    expect(opened.mock.calls.map(args => args[0])).toEqual(['https://connect.composio.example/link/1', 'https://connect.composio.example/link/1'])
    await act(async () => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('focus')) })
    expect(posts).toEqual([{ action: 'connect', slug: 'gmail' }, { action: 'refresh', id: ACCOUNT }])
    expect(host.querySelector('[data-managed-account="gmail"]')?.textContent).toContain('Signed in')
    expect(host.querySelector('[data-managed-account="outlook"]')?.textContent).toContain('Waiting')
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(posts).toHaveLength(2)
    expect(opened).toHaveBeenCalledTimes(2)
    expect(host.textContent).not.toContain('Open sign-in page')
})


test('checks a saved Connect account without opening a login and shows a revoked sign-in', async () => {
    const account = { id: ACCOUNT, slug: 'gmail', name: 'Gmail', status: 'active', agentIds: [] }
    const saved = { configured: true, connector: 'composio', apps, accounts: [account] }
    const { host, posts, opened } = await mount(saved, {
        refresh: { body: { view: { ...saved, accounts: [{ ...account, status: 'expired' }] } } },
    })
    await press(host, 'Check sign-in')
    expect(posts).toEqual([{ action: 'refresh', id: ACCOUNT }])
    expect(opened).not.toHaveBeenCalled()
    expect(host.textContent).toContain('The sign-in has expired.')
})
