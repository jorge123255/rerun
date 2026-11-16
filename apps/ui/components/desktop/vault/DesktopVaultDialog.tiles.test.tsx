// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopVaultEntry } from '@/lib/desktop/vault'

vi.mock('./DesktopManagedApps', () => ({ DesktopManagedApps: () => <section aria-label="Managed apps" /> }))
// The board's coworker avatar draws an SVG from the id; the test only needs to know whose it is.
vi.mock('@rerun/ui/iso-grid', () => ({ AgentBuddy: ({ agentId }: { agentId: string }) => <i data-buddy={agentId} /> }))
// The step animation has nothing to do with what is shown and does not settle in this DOM.
vi.mock('@/components/ui/panel-steps', () => ({ PanelSteps: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }))
vi.mock('./DesktopVaultCatalog', () => ({ DesktopVaultCatalog: ({ slug }: { slug?: string }) => <p data-testid="catalog">{slug ?? 'all'}</p> }))
import { DesktopVaultDialog, VaultAppTile } from './DesktopVaultDialog'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(() => { if (root) act(() => root!.unmount()); root = undefined; document.body.innerHTML = ''; vi.unstubAllGlobals() })
const mount = async (node: React.ReactNode) => {
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => { root!.render(node) })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
}
const ada = { id: '11111111-1111-4111-8111-111111111111', name: 'Ada Lovelace' }, bo = { id: '22222222-2222-4222-8222-222222222222', name: 'Bo' }
const entry = (extra: Record<string, unknown>) => ({ id: 'e1', revision: 'r1', name: 'notion', kind: 'mcp', url: 'https://mcp.notion.com/mcp', hasBearer: false, catalog: { slug: 'notion', methodId: 'oauth', name: 'Notion' }, sharedWithAll: false, agentIds: [], ...extra }) as unknown as DesktopVaultEntry

const catalogApps = [
    { slug: 'notion', name: 'Notion', icon: '/services/notion.svg?tone=dark' }, { slug: 'linear', name: 'Linear', icon: '/services/linear.svg' },
    { slug: 'github', name: 'GitHub' }, { slug: 'airtable', name: 'Airtable' }, { slug: 'asana', name: 'Asana' }, { slug: 'jira', name: 'Jira' },
    { slug: 'intercom', name: 'Intercom' }, { slug: 'context7', name: 'Context7' },
]
const serve = (listing: unknown) => vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).includes('/vault/catalog') ? Response.json(catalogApps) : Response.json(listing)))
const button = (label: string) => [...document.querySelectorAll('button')].find(node => (node.getAttribute('aria-label') ?? node.textContent) === label)

it('an empty Vault offers six popular apps the Mac can add and opens the Add page on the one chosen', async () => {
    serve({ entries: [], coworkers: [] })
    await mount(<DesktopVaultDialog onClose={() => {}} />)
    expect(document.body.textContent).toContain('Sign in once, share with your coworkers')
    // The header's Add is hidden while the Vault is empty: the empty state is the way in.
    expect(button('Add')).toBeUndefined()
    const popular = document.querySelector('[aria-label="Popular apps"]')!
    // Slack and HubSpot are not in this catalog, so they are not offered: each tile must lead somewhere.
    expect([...popular.querySelectorAll('button')].map(node => node.textContent)).toEqual(['Notion', 'Linear', 'GitHub', 'Airtable', 'Asana', 'Jira'])
    expect(popular.querySelector('img')?.getAttribute('src')).toBe('/services/notion.svg?tone=dark')
    // The icon sits above the name, three to a row.
    expect(popular.className).toContain('grid-cols-3')
    expect(popular.querySelector('button')!.className).toContain('flex-col')
    // Managed apps stay reachable under the empty state.
    expect(popular.compareDocumentPosition(document.querySelector('[aria-label="Managed apps"]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await act(async () => { [...popular.querySelectorAll('button')].find(node => node.textContent === 'Linear')!.click() })
    expect(document.querySelector('[data-testid=catalog]')?.textContent).toBe('linear')
})

it('the empty Vault\'s other buttons open the Add page on that kind', async () => {
    serve({ entries: [], coworkers: [] })
    await mount(<DesktopVaultDialog onClose={() => {}} />)
    for (const label of ['Other app', 'MCP server', 'Secret', 'Local program']) expect(button(label), label).toBeDefined()
    await act(async () => { button('Secret')!.click() })
    expect(document.body.textContent).toContain('Add to the Vault')
    expect(document.querySelector('[aria-pressed=true]')?.textContent).toBe('Secret')
    expect(document.querySelector<HTMLInputElement>('input[name=value]')?.type).toBe('password')
})

it('an app tile shows its logo, its account and the faces of who uses it', async () => {
    const open = vi.fn()
    await mount(<VaultAppTile entry={entry({ agentIds: [ada.id, bo.id], catalog: { slug: 'notion', methodId: 'oauth', name: 'Notion', label: 'Sales' } })} icon="/services/notion.svg" coworkers={[ada, bo]} onOpen={open} />)
    const tile = document.querySelector('button')!
    expect(tile.className).toContain('flex-col')
    expect(tile.querySelector('img')?.getAttribute('src')).toBe('/services/notion.svg')
    expect(tile.textContent).toBe('NotionSales')
    const faces = tile.querySelector('[aria-label="Used by Ada Lovelace, Bo"]')!
    expect([...faces.querySelectorAll('[data-buddy]')].map(node => node.getAttribute('data-buddy'))).toEqual([ada.id, bo.id])
    tile.click()
    expect(open).toHaveBeenCalledOnce()
})

it('marks an app shared with every coworker, draws nothing for one nobody uses, and counts past three faces', async () => {
    const crowd = ['33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555'].map((id, index) => ({ id, name: 'C' + index }))
    await mount(<>
        <VaultAppTile entry={entry({ sharedWithAll: true })} coworkers={[ada]} onOpen={() => {}} />
        <VaultAppTile entry={entry({ id: 'e2' })} coworkers={[ada]} onOpen={() => {}} />
        <VaultAppTile entry={entry({ id: 'e3', agentIds: [ada.id, bo.id, ...crowd.map(coworker => coworker.id)] })} coworkers={[ada, bo, ...crowd]} onOpen={() => {}} />
    </>)
    const [all, none, many] = [...document.querySelectorAll('button')]
    expect(all.querySelector('[aria-label="Every coworker"]')?.textContent).toBe('All')
    expect(none.querySelector('[role=img]')).toBeNull()
    expect(none.textContent).not.toContain('Unassigned')
    expect(many.querySelectorAll('[data-buddy]')).toHaveLength(3)
    expect(many.querySelector('[role=img]')?.textContent).toBe('+2')
    // No logo known for the app: a glyph, never a broken picture.
    expect(all.querySelector('img')).toBeNull()
})

it('a tile wears a badge only for a sign-in that needs the person, in the words of what happened', async () => {
    const health = (extra: Record<string, unknown>) => ({ slug: 'notion', methodId: 'oauth', name: 'Notion', health: { checkedAt: '2026-11-15T10:00:00.000Z', ...extra } })
    const cases: [Record<string, unknown>, string][] = [
        [{ signedOut: true }, 'Signed out'],
        [{ catalog: health({ state: 'disconnected' }) }, 'Signed out'],
        [{ catalog: health({ state: 'error', message: 'The app refused the saved key.', credentialRejected: true }) }, 'Key rejected'],
        [{ catalog: health({ state: 'error', message: 'The saved sign-in expired. Reconnect to check this account.' }) }, 'Sign-in expired'],
        [{ catalog: health({ state: 'error', message: 'The app did not respond to the connection check.' }) }, 'Check failed'],
        [{ catalog: health({ state: 'healthy', toolCount: 3 }) }, ''],
        [{}, ''],
    ]
    await mount(<>{cases.map(([extra], index) => <VaultAppTile key={index} entry={entry({ id: 'e' + index, ...extra })} coworkers={[]} onOpen={() => {}} />)}</>)
    expect([...document.querySelectorAll('[data-vault-badges]')].map(node => node.textContent)).toEqual(cases.map(([, label]) => label))
})
