// @vitest-environment happy-dom
import { act, useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { ApiConnectionsPanel } from './ApiConnectionsPanel'
import { ApiAddProviderPage } from './ApiAddProviderPage'
import { ApiConnectionDetail } from './ApiConnectionDetail'
import { ApiConnectionsSession } from '@/lib/desktop/api-connections/session'
import { apiFixture, catalogFixture } from '@/lib/desktop/api-connections/fixtures'
const roots: Root[] = []
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterEach(async () => { await act(async () => { for (const root of roots.splice(0)) root.unmount() }); document.body.innerHTML = ''; vi.restoreAllMocks() })
function createHost() { const host = document.body.appendChild(document.createElement('div')), root = createRoot(host); roots.push(root); return { host, root } }
test('the real panel lists both named siblings and selects the second connection exactly', async () => {
    const { host, root } = createHost(), catalog = catalogFixture(), api = apiFixture(catalog), select = vi.spyOn(api, 'select')
    await act(async () => root.render(<ApiConnectionsPanel workspaceId={1} currentWorkspace={() => 1} active api={api} selectionContext={{ source: 'workspace', runId: 'fixture-selection', sessionId: 'fixture-settings' }} />))
    expect(host.textContent).toContain('OpenAI one'); expect(host.textContent).toContain('OpenAI two')
    const control = host.querySelector<HTMLSelectElement>('select[aria-label="Default model"]')!
    const option = [...control.options].find(item => item.parentElement?.getAttribute('label') === 'OpenAI two')!
    await act(async () => { control.value = option.value; control.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(select.mock.calls[0][0].connectionId).toBe(catalog.connections[1].connectionId)
})
test('masked add input and Cancel preserve the private draft without creating a connection', async () => {
    const { host, root } = createHost(), api = apiFixture(), create = vi.spyOn(api, 'create'), session = new ApiConnectionsSession(1, api, () => 1)
    await session.refresh(); session.navigate({ kind: 'add', provider: 'openai' }); session.draft('add:openai', { name: 'Other OpenAI' }); session.changeDraft('add:openai', { secret: 'offline-fixture-only' })
    await act(async () => root.render(<ApiAddProviderPage provider="openai" session={session} />))
    expect(host.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe('offline-fixture-only')
    expect(host.textContent).not.toContain('offline-fixture-only')
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Cancel')!.click())
    expect(session.snapshot().page.kind).toBe('list'); expect(create).not.toHaveBeenCalled()
    expect(session.draft('add:openai').secret).toBe('offline-fixture-only')
    expect(JSON.stringify(session.snapshot())).not.toContain('offline-fixture-only')
    session.close()
})
test('detail shows no stored secret, describes exact removal effects and Cancel performs no remove', async () => {
    const { root } = createHost(), catalog = catalogFixture(), api = apiFixture(catalog), remove = vi.spyOn(api, 'remove'), session = new ApiConnectionsSession(1, api, () => 1)
    await session.refresh(); session.navigate({ kind: 'detail', connectionId: catalog.connections[0].connectionId })
    function Detail() { useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot); return <ApiConnectionDetail connection={session.connection(catalog.connections[0].connectionId)!} session={session} /> }
    await act(async () => root.render(<Detail />))
    expect(document.body.textContent).toContain('Saved keys are never shown')
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('Remove OpenAI one'))!.click())
    expect(document.body.textContent).toContain('Writer (coworker-a)')
    expect(document.body.textContent).toContain('Schedule daily (coworker-a)')
    expect(document.body.textContent).toContain('saved default will be cleared')
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(button => button.textContent === 'Cancel')!.click())
    expect(remove).not.toHaveBeenCalled(); session.close()
})
test('missing local service or selection authority is unavailable, without a fabricated probe', async () => {
    const { host, root } = createHost()
    await act(async () => root.render(<ApiConnectionsPanel workspaceId={1} currentWorkspace={() => 1} active api={null} selectionContext={null} />))
    expect(host.textContent).toContain('API connections are unavailable')
    expect(host.querySelector('input[type="password"]')).toBeNull()
    const api = apiFixture()
    await act(async () => root.render(<ApiConnectionsPanel workspaceId={1} currentWorkspace={() => 1} active api={api} selectionContext={null} />))
    expect(host.querySelector<HTMLSelectElement>('select')?.disabled).toBe(true)
    expect(host.textContent).toContain('Key saved'); expect(host.textContent).not.toContain('Probe succeeded')
})
