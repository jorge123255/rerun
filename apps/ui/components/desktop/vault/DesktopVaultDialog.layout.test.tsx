// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('./DesktopManagedApps', () => ({ DesktopManagedApps: () => <section aria-label="Managed apps" /> }))
vi.mock('@/components/ui/panel-steps', () => ({ PanelSteps: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }))
vi.mock('./DesktopVaultCatalog', () => ({ DesktopVaultCatalog: ({ slug, listHeader }: { slug?: string; listHeader?: React.ReactNode }) => <div>{listHeader}<p data-testid="catalog">{slug ?? 'all'}</p></div> }))
// The browser sign-in panel asks the engine where the sign-in stands; that is its own test's business.
vi.mock('../mcp/DesktopMcpOAuthAuthorize', () => ({ DesktopMcpOAuthAuthorize: () => null }))
vi.mock('@rerun/ui/iso-grid', () => ({ AgentBuddy: ({ agentId }: { agentId: string }) => <i data-buddy={agentId} /> }))
import { DesktopVaultDialog } from './DesktopVaultDialog'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(() => { if (root) act(() => root!.unmount()); root = undefined; document.body.innerHTML = ''; vi.unstubAllGlobals() })
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
const mount = async (node: React.ReactNode) => {
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => { root!.render(node) })
    await settle()
}
const ada = { id: '11111111-1111-4111-8111-111111111111', name: 'Ada' }, bo = { id: '22222222-2222-4222-8222-222222222222', name: 'Bo' }
const uuid = (n: number) => `${String(n).repeat(8)}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`
const app = { id: uuid(1), revision: uuid(2), name: 'notion', kind: 'mcp', url: 'https://mcp.notion.com/mcp', hasBearer: false, signedOut: true, browserSignIn: true, catalog: { slug: 'notion', methodId: 'oauth', name: 'Notion', label: 'Sales' }, sharedWithAll: false, agentIds: [ada.id] }
const server = { id: uuid(3), revision: uuid(4), name: 'internal-tools', kind: 'mcp', url: 'https://tools.example.com/mcp', hasBearer: true, sharedWithAll: true, agentIds: [] }
const program = { id: uuid(5), revision: uuid(6), name: 'local-db', kind: 'program', executable: '/usr/local/bin/db-mcp', args: [], credentialNames: [], sharedWithAll: false, agentIds: [] }
const secret = { id: uuid(7), revision: uuid(8), name: 'Stripe key', variable: 'STRIPE_API_KEY', sharedWithAll: false, agentIds: [bo.id] }
const full = { entries: [secret, program, app, server], coworkers: [ada, bo] }

type Post = Record<string, unknown>
/** Answers the list, then each change in turn: a listing, or a refusal. */
function serve(listing: unknown, answers: ({ status: number; error: string } | unknown)[] = [], hold?: Promise<void>) {
    const posts: Post[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes('/vault/catalog')) return Response.json([{ slug: 'notion', name: 'Notion', icon: '/services/notion.svg' }])
        if (init?.method !== 'POST') { await hold; return Response.json(listing) }
        posts.push({ url: String(input), ...JSON.parse(String(init.body)) })
        const answer = answers.shift() as { status?: number; error?: string } | undefined
        return answer?.status ? Response.json({ error: answer.error }, { status: answer.status }) : Response.json(answer ?? listing)
    }))
    return posts
}
const control = (label: string) => [...document.querySelectorAll<HTMLElement>('button,[role=button]')].find(node => (node.getAttribute('aria-label') ?? node.textContent) === label)
const press = async (label: string) => { await act(async () => { control(label)!.click() }); await settle() }
const toggle = (label: string) => document.querySelector<HTMLButtonElement>(`[role=switch][aria-label="${label}"]`)!

it('shows the shape of the list while the Vault is read, not a sentence', async () => {
    let release = () => {}
    serve(full, [], new Promise<void>(resolve => { release = resolve }))
    await mount(<DesktopVaultDialog onClose={() => {}} />)
    expect(document.querySelector('[role=status][aria-label="Loading Vault"]')).not.toBeNull()
    expect(document.body.textContent).not.toContain('Loading Vault')
    expect(control('Add')).toBeUndefined()
    await act(async () => { release() })
    await settle()
    expect(document.querySelector('[aria-label="Loading Vault"]')).toBeNull()
})

it('lays the Vault out as the cloud does: one Add, app tiles, then rows, then managed apps', async () => {
    serve(full)
    await mount(<DesktopVaultDialog onClose={() => {}} />)
    const text = document.body.textContent!
    expect(text).toContain('Sign in to an app once, then pick the coworkers that use it.')
    for (const gone of ['Vault entries', 'Add app', 'Add secret', 'Add MCP server', 'Add local program', 'Unassigned', 'Sign-in required']) expect(text, gone).not.toContain(gone)
    expect(document.querySelectorAll('h4')).toHaveLength(0)
    expect(control('Add')).toBeDefined()
    const tiles = document.querySelector('[data-vault-apps]')!
    expect(tiles.className).toContain('grid-cols-2')
    expect(tiles.className).toContain('@md:grid-cols-3')
    expect([...tiles.querySelectorAll('button')].map(node => node.textContent)).toEqual(['Signed outNotionSales'])
    expect(tiles.querySelector('img')?.getAttribute('src')).toBe('/services/notion.svg')
    expect(tiles.querySelector('[data-buddy]')?.getAttribute('data-buddy')).toBe(ada.id)
    // MCP servers, local programs and secrets follow as rows, in that order, each saying what it is.
    const rows = [...document.querySelectorAll('[data-vault-rows] [role=button]')]
    expect(rows.map(node => node.textContent)).toEqual(['internal-toolsMCP serverAll', 'local-dbLocal program', 'Stripe keySecret'])
    expect(rows[2].querySelector('[aria-label="Used by Bo"] [data-buddy]')?.getAttribute('data-buddy')).toBe(bo.id)
    const managed = document.querySelector('[aria-label="Managed apps"]')!
    expect(document.querySelector('[data-vault-rows]')!.compareDocumentPosition(managed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Nothing a secret holds is in the listing, so nothing of it can be on the page.
    expect(text).not.toContain('STRIPE_API_KEY')
})

it('Add opens one page with four kinds, and each form sends what it sent before', async () => {
    const posts = serve(full)
    await mount(<DesktopVaultDialog onClose={() => {}} />)
    await press('Add')
    expect(document.body.textContent).toContain('Add to the Vault')
    expect([...document.querySelectorAll('[aria-pressed]')].map(node => node.textContent)).toEqual(['Apps', 'MCP server', 'Secret', 'Local program'])
    expect(document.querySelector('[data-testid=catalog]')?.textContent).toBe('all')
    await press('Local program')
    expect(document.querySelector('[data-testid=catalog]')).toBeNull()
    const form = document.querySelector('form')!
    const set = (name: string, value: string) => { (form.elements.namedItem(name) as HTMLInputElement).value = value }
    set('name', 'files'); set('executable', '/opt/files-mcp'); set('arguments', '--stdio')
    await act(async () => { form.requestSubmit() })
    await settle()
    expect(posts).toEqual([{ url: '/api/desktop/vault', operation: 'create-program', name: 'files', executable: '/opt/files-mcp', args: ['--stdio'] }])
    // Saved: back on the list.
    expect(document.querySelector('[data-vault-apps]')).not.toBeNull()
    await press('Add')
    await press('Back')
    expect(document.querySelector('[data-vault-apps]')).not.toBeNull()
})

it('a coworker switch saves at once, one change at a time, with the revision the entry has then', async () => {
    const afterAda = { ...full, entries: [secret, program, { ...app, revision: uuid(9), agentIds: [ada.id, bo.id] }, server] }
    const afterAll = { ...full, entries: [secret, program, { ...app, revision: uuid(0), agentIds: [ada.id, bo.id], sharedWithAll: true }, server] }
    const posts = serve(full, [afterAda, afterAll])
    await mount(<DesktopVaultDialog onClose={() => {}} />)
    await press('Signed outNotionSales')
    expect(document.body.textContent).not.toContain('Save assignments')
    expect(document.querySelector('input[type=checkbox]')).toBeNull()
    expect(document.querySelector('[aria-label="Coworkers"] h4')?.textContent).toBe('Coworkers')
    expect([toggle('Every coworker'), toggle('Ada'), toggle('Bo')].map(node => node.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false'])
    await act(async () => { toggle('Bo').click() })
    await settle()
    expect(posts[0]).toEqual({ url: '/api/desktop/vault', operation: 'share', id: app.id, revision: app.revision, agentIds: [ada.id, bo.id], sharedWithAll: false })
    expect(toggle('Bo').getAttribute('aria-checked')).toBe('true')
    await act(async () => { toggle('Every coworker').click() })
    await settle()
    // The second change carries the revision the first one produced, and keeps the individual picks.
    expect(posts[1]).toEqual({ url: '/api/desktop/vault', operation: 'share', id: app.id, revision: uuid(9), agentIds: [ada.id, bo.id], sharedWithAll: true })
    expect(toggle('Every coworker').getAttribute('aria-checked')).toBe('true')
    expect(toggle('Ada').disabled).toBe(true)
})

it('a refused switch says why in the Vault\'s words and stays where the Vault has it', async () => {
    const posts = serve(full, [{ status: 409, error: 'This Vault entry changed. Reopen it and try again.' }])
    await mount(<DesktopVaultDialog onClose={() => {}} />)
    await press('Signed outNotionSales')
    await act(async () => { toggle('Ada').click() })
    await settle()
    expect(posts[0]).toMatchObject({ operation: 'share', revision: app.revision, agentIds: [], sharedWithAll: false })
    expect(document.querySelector('[role=alert]')?.textContent).toBe('This Vault entry changed. Reopen it and try again.')
    expect(toggle('Ada').getAttribute('aria-checked')).toBe('true')
})

it('the detail keeps the Mac\'s own actions behind a back-arrow header', async () => {
    const posts = serve(full)
    await mount(<DesktopVaultDialog onClose={() => {}} />)
    await press('Signed outNotionSales')
    for (const label of ['Back', 'Check connection', 'Rename account', 'Change authentication', 'Delete app', 'Disconnect browser sign-in']) expect(control(label), label).toBeDefined()
    expect(document.body.textContent).toContain('Sign-in required')
    await press('Check connection')
    expect(posts).toEqual([{ url: '/api/desktop/vault/health', id: app.id, revision: app.revision }])
    await press('Back')
    expect(document.querySelector('[data-vault-apps]')).not.toBeNull()
})

it('opened for one coworker app it lists that app only and adds an account of it', async () => {
    serve(full)
    await mount(<DesktopVaultDialog onClose={() => {}} coworkerApp="notion" />)
    expect(document.querySelector('[data-vault-rows]')).toBeNull()
    expect(document.querySelector('[aria-label="Managed apps"]')).toBeNull()
    await press('Add account')
    expect(document.querySelector('[data-testid=catalog]')?.textContent).toBe('notion')
})

it('opened from a chat suggestion it goes straight to that app and offers no way into the rest of the Vault', async () => {
    serve(full)
    const onClose = vi.fn()
    await mount(<DesktopVaultDialog onClose={onClose} suggestedApp={{ slug: 'notion', onUse: () => {} }} />)
    expect(document.querySelector('[data-testid=catalog]')?.textContent).toBe('notion')
    expect(control('Add')).toBeUndefined()
    expect(document.querySelector('[data-vault-apps]')).toBeNull()
})
