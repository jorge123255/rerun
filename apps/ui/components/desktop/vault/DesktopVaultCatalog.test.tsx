// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('../services/accounts/DesktopServiceAccountForm', () => ({
    DesktopServiceAccountForm: ({ identity, submitLabel }: { identity: string; submitLabel: string }) => <p data-testid="form">{identity}:{submitLabel}</p>,
}))
import { DesktopVaultCatalog } from './DesktopVaultCatalog'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(() => { if (root) act(() => root!.unmount()); root = undefined; document.body.innerHTML = ''; vi.unstubAllGlobals() })
const apps = [
    { slug: 'notion', name: 'Notion', summary: 'Docs and wikis', icon: '/services/notion.svg', multiInstance: false, methods: [] },
    { slug: 'linear', name: 'Linear', summary: 'Issue tracking', multiInstance: true, methods: [] },
]
async function mount(node: React.ReactNode, hold?: Promise<void>) {
    const asked: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => { asked.push(String(input)); await hold; return Response.json(apps) }))
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => { root!.render(node) })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    return asked
}
function type(input: HTMLInputElement, value: string) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
}
const noop = async () => {}

it('as the Add page it keeps the header it is handed over a searchable list of app rows', async () => {
    const asked = await mount(<DesktopVaultCatalog busy={false} listHeader={<p data-testid="header">Add to the Vault</p>} existingAccounts={{ linear: ['Linear'] }} onSave={noop} onCancel={() => {}} />)
    expect(asked).toEqual(['/api/desktop/vault/catalog'])
    expect(document.querySelector('[data-testid=header]')).not.toBeNull()
    expect(document.body.textContent).not.toContain('Add an app')
    const rows = () => [...document.querySelectorAll('[role=button]')].map(node => node.textContent)
    expect(rows()).toEqual(['NotionDocs and wikis', 'LinearIssue tracking1 in Vault'])
    await act(async () => { type(document.querySelector<HTMLInputElement>('input[aria-label="Search apps"]')!, 'issue') })
    expect(rows()).toEqual(['LinearIssue tracking1 in Vault'])
    await act(async () => { type(document.querySelector<HTMLInputElement>('input[aria-label="Search apps"]')!, 'zzz') })
    expect(document.body.textContent).toContain('No matching apps.')
})

it('a picked app gets a back-arrow header in place of the list header, and the arrow returns to the apps', async () => {
    await mount(<DesktopVaultCatalog busy={false} listHeader={<p data-testid="header">Add to the Vault</p>} onSave={noop} onCancel={() => {}} />)
    await act(async () => { document.querySelector<HTMLElement>('[role=button]')!.click() })
    expect(document.querySelector('[data-testid=header]')).toBeNull()
    expect(document.querySelector('[data-testid=form]')?.textContent).toBe('notion:Save app')
    const back = document.querySelector<HTMLButtonElement>('[data-slot=panel-editor-back]')!
    expect(back.getAttribute('aria-label')).toBe('All apps')
    await act(async () => { back.click() })
    expect(document.querySelector('[data-testid=header]')).not.toBeNull()
})

it('opened on one app its arrow leads where the page says, and there is none when it says nowhere', async () => {
    const onBack = vi.fn()
    await mount(<DesktopVaultCatalog slug="linear" busy={false} listHeader={null} onBack={onBack} onSave={noop} onCancel={() => {}} />)
    expect(document.querySelector('[data-testid=form]')?.textContent).toBe('linear:Save app')
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-slot=panel-editor-back]')!.click() })
    expect(onBack).toHaveBeenCalledOnce()
    act(() => root!.unmount()); document.body.innerHTML = ''
    await mount(<DesktopVaultCatalog slug="linear" busy={false} listHeader={null} onSave={noop} onCancel={() => {}} />)
    expect(document.querySelector('[data-slot=panel-editor-back]')).toBeNull()
})

it('shows rows taking shape while the catalog is read', async () => {
    let release = () => {}
    await mount(<DesktopVaultCatalog busy={false} listHeader={<p>Add to the Vault</p>} onSave={noop} onCancel={() => {}} />, new Promise<void>(resolve => { release = resolve }))
    expect(document.querySelector('[role=status][aria-label="Loading apps"]')).not.toBeNull()
    await act(async () => { release() })
})

it('inside an entry it is still only the form that replaces a key', async () => {
    await mount(<DesktopVaultCatalog slug="notion" editing busy={false} onSave={noop} onCancel={() => {}} />)
    expect(document.querySelector('[data-slot=panel-editor-back]')).toBeNull()
    expect(document.querySelector('h3')?.textContent).toBe('Notion')
    expect(document.querySelector('[data-testid=form]')?.textContent).toBe('notion:Save authentication')
})
