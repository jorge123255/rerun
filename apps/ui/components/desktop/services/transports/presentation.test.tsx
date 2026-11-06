// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { ServiceTransportSetup, type ServiceTransportSetupPorts } from './ServiceTransportSetup'
import { ServiceTransportConnection } from './ServiceTransportConnection'
import { ServiceTransportMethodPicker } from './ServiceTransportMethodPicker'
import type { ServiceTransportMethod, ServiceTransportSetupIntent, ServiceTransportSnapshot } from '../../../../../../packages/contracts/src/desktop-service-transports'
const ref = { agentId: 'alice', key: 'example', installationId: '00000000-0000-4000-8000-000000000001', revision: '00000000-0000-4000-8000-000000000002' }
const requestId = '00000000-0000-4000-8000-000000000003'
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const roots: Root[] = []
function mount() { const root = createRoot(document.body.appendChild(document.createElement('div'))); roots.push(root); return root }
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === text)!
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); document.body.innerHTML = '' })
const methods: ServiceTransportMethod[] = [
    { id: 'token', label: 'Permanent Access Token', kind: 'key', recommended: true, inputs: [{ key: 'TOKEN', type: 'password', label: 'API key', required: true, secret: true, placeholder: 'eyJ…' }], requiresSecrets: true, transport: 'sse', availability: 'supported', reason: 'ready' },
    { id: 'program', label: 'Access token (local server)', kind: 'stdio', recommended: false, inputs: [], requiresSecrets: false, transport: 'stdio', availability: 'dependent', reason: 'program' },
]
test('reuses original ordered authentication cards and exact catalog labels', async () => {
    const root = mount(), select = vi.fn()
    await act(async () => root.render(<ServiceTransportMethodPicker methods={methods} onSelect={select} />))
    expect([...document.querySelectorAll('button')].map(b => b.textContent)).toEqual(expect.arrayContaining(['Permanent Access TokenPaste an API key from the service.', 'Access token (local server)Runs locally on your engine.']))
    await act(async () => button('Access token (local server)Runs locally on your engine.').click())
    expect(select).toHaveBeenCalledWith('program')
})
test('mount does not save/probe; unknown setup acknowledgement retains exact id after reopening', async () => {
    let stored: ServiceTransportSetupIntent | null = null
    const ports: ServiceTransportSetupPorts = { uuid: () => requestId, journal: { read: async () => stored, put: async value => { stored = value }, clear: async () => { stored = null } }, save: vi.fn(async intent => ({ requestId: intent.requestId, outcome: 'unknown' as const })), reconcile: vi.fn(async intent => ({ requestId: intent.requestId, outcome: 'saved' as const, ref: { ...ref, revision: '00000000-0000-4000-8000-000000000004' } })) }
    const saved = vi.fn(), root = mount()
    const render = (revision = ref.revision) => <ServiceTransportSetup account={{ ...ref, revision }} name="Example" methods={methods} initialMethodId="token" configuredInputs={{ TOKEN: true }} ports={ports} onSaved={saved} onCancel={() => {}} />
    await act(async () => root.render(render()))
    expect(ports.save).not.toHaveBeenCalled(); expect(document.querySelector<HTMLInputElement>('input')?.type).toBe('password')
    await act(async () => button('Install').click())
    expect(saved).not.toHaveBeenCalled(); expect(await ports.journal.read(ref)).toEqual(expect.objectContaining({ requestId }))
    expect(JSON.stringify(stored)).not.toContain('TOKEN')
    await act(async () => root.render(render('00000000-0000-4000-8000-000000000004')))
    expect(ports.save).toHaveBeenCalledTimes(1)
    await act(async () => button('Reconcile').click())
    expect(ports.reconcile).toHaveBeenCalledWith(expect.objectContaining({ requestId }), expect.any(AbortSignal)); expect(saved).toHaveBeenCalledOnce()
})
test('late owner reads cannot overwrite current account or trigger discovery', async () => {
    let old!: (value: ServiceTransportSnapshot) => void
    const next = { ...ref, agentId: 'bob' }, root = mount()
    const status = vi.fn((r: typeof ref) => r.agentId === ref.agentId ? new Promise<ServiceTransportSnapshot>(resolve => { old = resolve }) : Promise.resolve({ ref: r, methodId: 'token', transport: 'sse' as const, state: 'unchecked' as const, tools: [], observation: 'saved' as const }))
    const client = { status, pending: async () => null, perform: vi.fn(), reconcile: vi.fn(), stop: vi.fn(), retryConnection: vi.fn() }
    await act(async () => root.render(<ServiceTransportConnection account={ref} name="Old account" client={client} />))
    await act(async () => root.render(<ServiceTransportConnection account={next} name="New account" client={client} />))
    await act(async () => old({ ref, methodId: 'token', transport: 'sse', state: 'healthy', tools: [], observation: 'live' }))
    expect(document.body.textContent).toContain('New account'); expect(document.body.textContent).not.toContain('healthy'); expect(client.perform).not.toHaveBeenCalled()
})
test('Stop stays available while an explicit connection check waits', async () => {
    const root = mount(), snapshot: ServiceTransportSnapshot = { ref, methodId: 'token', transport: 'sse', state: 'unchecked', tools: [], observation: 'saved' }
    const client = { status: async () => snapshot, pending: async () => null, perform: vi.fn(() => new Promise<ServiceTransportSnapshot>(() => {})), reconcile: vi.fn(), retryConnection: vi.fn(), stop: vi.fn(async () => ({ ...snapshot, state: 'disconnected' as const })) }
    await act(async () => root.render(<ServiceTransportConnection account={ref} name="Example" client={client} />))
    await act(async () => button('Check connection').click())
    expect(button('Stop').disabled).toBe(false)
    await act(async () => button('Stop').click()); expect(client.stop).toHaveBeenCalledOnce()
})

test('a confirmed refused setup clears its exact pending journal so the user can correct it', async () => {
    let stored: ServiceTransportSetupIntent | null = null
    const clear = vi.fn(async (intent: ServiceTransportSetupIntent) => { if (stored?.requestId === intent.requestId) stored = null })
    const ports: ServiceTransportSetupPorts = { uuid: () => requestId, journal: { read: async () => stored, put: async value => { stored = value }, clear }, save: vi.fn(async intent => ({ requestId: intent.requestId, outcome: 'refused' as const })), reconcile: vi.fn() }
    const root = mount(), saved = vi.fn()
    await act(async () => root.render(<ServiceTransportSetup account={ref} name="Example" methods={methods} initialMethodId="token" configuredInputs={{ TOKEN: true }} ports={ports} onSaved={saved} onCancel={() => {}} />))
    await act(async () => button('Install').click())
    expect(clear).toHaveBeenCalledWith(expect.objectContaining({ requestId }))
    expect(stored).toBeNull(); expect(saved).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Configuration was not saved')
    expect(button('Install').disabled).toBe(false)
})
