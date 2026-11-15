// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopVaultEntry } from '@/lib/desktop/vault'

vi.mock('./DesktopManagedApps', () => ({ DesktopManagedApps: () => null }))
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

it('an empty Vault offers the six popular apps and opens the Add page on the one chosen', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).includes('/vault/catalog')
        ? Response.json([{ slug: 'notion', name: 'Notion', icon: '/services/notion.svg?tone=dark' }])
        : Response.json({ entries: [], coworkers: [] })))
    await mount(<DesktopVaultDialog onClose={() => {}} />)
    const popular = document.querySelector('[aria-label="Popular apps"]')!
    expect([...popular.querySelectorAll('button')].map(button => button.textContent)).toEqual(['Notion', 'Slack', 'HubSpot', 'Linear', 'GitHub', 'Airtable'])
    expect(popular.querySelector('img')?.getAttribute('src')).toBe('/services/notion.svg?tone=dark')
    await act(async () => { [...popular.querySelectorAll('button')].find(button => button.textContent === 'Linear')!.click() })
    expect(document.querySelector('[data-testid=catalog]')?.textContent).toBe('linear')
})

it('an app tile shows its logo and who uses it', async () => {
    const open = vi.fn()
    await mount(<VaultAppTile entry={entry({ agentIds: [ada.id, bo.id] })} icon="/services/notion.svg" coworkers={[ada, bo]} onOpen={open} />)
    const tile = document.querySelector('button')!
    expect(tile.querySelector('img')?.getAttribute('src')).toBe('/services/notion.svg')
    expect(tile.textContent).toContain('Notion')
    expect(tile.querySelector('[aria-label="Used by Ada Lovelace, Bo"]')?.textContent).toBe('ALB')
    tile.click()
    expect(open).toHaveBeenCalledOnce()
})

it('marks an app shared with every coworker, and one nobody uses', async () => {
    await mount(<><VaultAppTile entry={entry({ sharedWithAll: true })} coworkers={[ada]} onOpen={() => {}} /><VaultAppTile entry={entry({ id: 'e2' })} coworkers={[ada]} onOpen={() => {}} /></>)
    const [all, none] = [...document.querySelectorAll('button')]
    expect(all.querySelector('[aria-label="Every coworker"]')?.textContent).toBe('All')
    expect(none.querySelector('[aria-label="Unassigned"]')?.textContent).toBe('Unassigned')
    // No logo known for the app: the plain connector mark, never a broken picture.
    expect(all.querySelector('img')).toBeNull()
})
