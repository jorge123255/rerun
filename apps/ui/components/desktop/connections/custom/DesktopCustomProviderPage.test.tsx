// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi, type Mock } from 'vitest'
import type { CustomProviderChange, CustomProviderIdentity, CustomProviderModel, CustomProviderProbe, CustomProviderSnapshot } from '@rerun/contracts'
import { OTHER_WORKSPACE, RETIRED_MODEL, DEFAULT_LOCK } from '@/lib/desktop/custom-providers'
import { DesktopCustomProviderPage, type DesktopCustomProviderPageProps } from './DesktopCustomProviderPage'

const roots: Root[] = []
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterEach(async () => {
    await act(async () => { for (const root of roots.splice(0)) root.unmount() })
    document.body.innerHTML = ''
    vi.restoreAllMocks()
})

const manual: CustomProviderModel = { id: 'llama3.3:70b', contextWindow: null, vision: false, source: 'manual' }
const identity = { workspaceId: 1, connectionId: 'cnx-ollama', revision: 1 }

function snapshot(over: { revision?: number; name?: string; configuredSecret?: boolean; state?: CustomProviderSnapshot['state']; models?: CustomProviderModel[]; catalog?: CustomProviderSnapshot['catalog'] } = {}): CustomProviderSnapshot {
    return {
        workspaceId: 1, connectionId: 'cnx-ollama', revision: over.revision ?? 1,
        configuredSecret: over.configuredSecret ?? false, state: over.state ?? 'configured',
        config: {
            name: over.name ?? 'Ollama', baseUrl: 'http://localhost:11434/v1', preset: 'ollama',
            models: over.models ?? [manual], contextWindow: null, vision: false,
            policy: { reviewedOrigin: 'http://localhost:11434', allowHttp: true, allowPrivate: true },
        },
        catalog: over.catalog ?? { status: 'never', models: [], observedAt: null, attemptedAt: null },
    }
}

function probe(over: Partial<CustomProviderProbe> = {}): CustomProviderProbe {
    return { identity, status: 'unavailable', models: [], problem: 'not_listed', manualModel: manual.id, manualUsable: true, observedAt: 1, ...over }
}

function button(label: string) {
    const found = [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === label || item.getAttribute('aria-label') === label)
    if (!(found instanceof HTMLButtonElement)) throw new Error(`missing ${label}`)
    return found
}
function field(label: string) {
    const labelled = [...document.querySelectorAll('label')].find(item => item.textContent?.includes(label))
    const input = labelled?.getAttribute('for') ? document.getElementById(labelled.getAttribute('for') ?? '') : null
    if (!(input instanceof HTMLInputElement)) throw new Error(`missing ${label}`)
    return input
}
async function typeInto(label: string, value: string) {
    const input = field(label)
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    await act(async () => input.dispatchEvent(new Event('input', { bubbles: true })))
}
async function blur(label: string) {
    const input = field(label)
    await act(async () => {
        input.dispatchEvent(new FocusEvent('blur', { bubbles: false }))
        input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
}
async function flush() {
    for (let i = 0; i < 8; i += 1) await act(async () => { await Promise.resolve() })
}

type Adapter = NonNullable<DesktopCustomProviderPageProps['adapter']>
function adapter() {
    const read = vi.fn<Adapter['read']>(async id => ({ ok: true, value: { ...snapshot({ revision: id.revision }), workspaceId: id.workspaceId, connectionId: id.connectionId } }))
    const change = vi.fn<Adapter['change']>(async body => {
        const next = body.action === 'create' ? { workspaceId: body.workspaceId, connectionId: body.connectionId, revision: 1 } : { ...body.identity, revision: body.identity.revision + (body.action === 'disconnect' ? 0 : 1) }
        return { ok: true as const, value: { requestId: body.requestId, identity: next, action: body.action, status: 'recorded' as const, recovered: false } }
    })
    const probeFn = vi.fn<Adapter['probe']>(async () => ({ ok: true, value: probe() }))
    const probeDraft = vi.fn<Adapter['probeDraft']>(async body => ({
        ok: true as const,
        value: { requestId: body.requestId, workspaceId: body.workspaceId, status: 'unavailable' as const, models: [] as CustomProviderModel[], problem: 'not_listed' as const, manualModel: body.manualModel ?? null, manualUsable: Boolean(body.manualModel), observedAt: 1 },
    }))
    return { read, change, probe: probeFn, probeDraft }
}

type MountProps = Partial<Omit<DesktopCustomProviderPageProps, 'adapter' | 'onBack' | 'onReceipt'>> & {
    adapter?: ReturnType<typeof adapter>
    onBack?: Mock<DesktopCustomProviderPageProps['onBack']>
    onReceipt?: Mock<NonNullable<DesktopCustomProviderPageProps['onReceipt']>>
}
async function mount(props: MountProps = {}) {
    const root = createRoot(document.body.appendChild(document.createElement('div')))
    roots.push(root)
    const client = props.adapter ?? adapter()
    const onBack = props.onBack ?? vi.fn<DesktopCustomProviderPageProps['onBack']>()
    const onReceipt = props.onReceipt ?? vi.fn<NonNullable<DesktopCustomProviderPageProps['onReceipt']>>()
    await act(async () => root.render(<DesktopCustomProviderPage workspaceId={1} takenNames={[]} onBack={onBack} onReceipt={onReceipt} adapter={client} {...props} />))
    await flush()
    return { root, client, onBack, onReceipt, rerender: async (next: Partial<DesktopCustomProviderPageProps>) => { await act(async () => root.render(<DesktopCustomProviderPage workspaceId={1} takenNames={[]} onBack={onBack} onReceipt={onReceipt} adapter={client} {...props} {...next} />)); await flush() } }
}

test('probes before create, then keeps a typed model when the server lists none', async () => {
    const { client } = await mount()
    expect(field('Name').value).toBe('Ollama')
    expect(field('Base URL').value).toBe('http://localhost:11434/v1')
    expect(field('API key').placeholder).toBe('None for a local server')
    expect(document.querySelector('[data-custom-provider-page]')?.className).toContain('min-h-0')
    expect(document.querySelector('.overflow-y-auto')).toBeTruthy()
    expect(document.querySelector('.flex-wrap')).toBeTruthy()
    await act(async () => { button('Connect').click() })
    await flush()
    expect(field('Model id')).toBeTruthy()
    expect(client.change).not.toHaveBeenCalled()
    expect(client.probe).not.toHaveBeenCalled()
    expect(client.probeDraft.mock.calls[0]?.[0]).toMatchObject({ action: 'probe_draft', workspaceId: 1, baseUrl: 'http://localhost:11434/v1' })
    expect(client.probeDraft.mock.calls[0]?.[0]).not.toHaveProperty('manualModel')
    await typeInto('Model id', 'llama3.3:70b')
    await act(async () => { button('Connect').click() })
    await flush()
    expect(client.probeDraft.mock.calls[1]?.[0]).toMatchObject({ manualModel: 'llama3.3:70b' })
    expect(document.body.textContent).toContain('This server does not list its models. Type the id of the one to run.')
    expect(document.body.textContent).toContain('llama3.3:70b')
    expect(document.body.textContent).not.toContain('Disconnected')
    expect(document.body.textContent).not.toContain('invented-model')
    expect(document.querySelector('[data-connection-state="configured"]')).toBeTruthy()
    expect(document.querySelector('.break-words')).toBeTruthy()
    const created = client.change.mock.calls[0]?.[0] as CustomProviderChange
    expect(created.action).toBe('create')
    if (created.action === 'create') {
        expect(created.config.models).toEqual([{ id: 'llama3.3:70b', contextWindow: null, vision: false, source: 'manual' }])
        expect(JSON.stringify(created.config.models)).not.toContain('discovered')
    }
    expect(client.probe).toHaveBeenCalled()
})

test('an uncertain create is retried with the same request and an edited save waits', async () => {
    const client = adapter()
    client.change.mockImplementation(async (body: CustomProviderChange) => ({
        ok: true as const,
        value: {
            requestId: body.requestId,
            identity: body.action === 'create' ? { workspaceId: body.workspaceId, connectionId: body.connectionId, revision: 1 } : { ...body.identity, revision: body.identity.revision },
            action: body.action,
            status: 'uncertain' as const,
            recovered: false,
        },
    }))
    await mount({ adapter: client })
    await act(async () => { button('Connect').click() })
    await flush()
    await typeInto('Model id', 'llama3.3:70b')
    await act(async () => { button('Connect').click() })
    await flush()
    const first = client.change.mock.calls[0]?.[0] as CustomProviderChange
    expect(first.action).toBe('create')
    await typeInto('Name', 'Renamed')
    await act(async () => { button('Save').click() })
    await flush()
    expect(client.change).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).toContain('Saved, waiting to confirm the receipt.')
    await act(async () => { button('Discard').click() })
    await act(async () => { button('Retry').click() })
    await flush()
    const second = client.change.mock.calls[1]?.[0] as CustomProviderChange
    expect(second.action).toBe('create')
    if (first.action === 'create' && second.action === 'create') expect(second.requestId).toBe(first.requestId)
})

test('searches discovered models and explains a retired or default choice', async () => {
    const discovered: CustomProviderModel[] = [
        { id: 'llama3.2:3b', contextWindow: 8192, vision: false, source: 'discovered' },
        { id: 'qwen3:4b', contextWindow: null, vision: false, source: 'discovered' },
    ]
    const oldModel: CustomProviderModel = { id: 'old-model', contextWindow: null, vision: false, source: 'discovered' }
    const client = adapter()
    client.read.mockResolvedValue({ ok: true, value: snapshot({ models: [manual, oldModel], catalog: { status: 'fresh', models: discovered, observedAt: 1, attemptedAt: 1 } }) })
    await mount({ identity, defaultModel: { connectionId: identity.connectionId, model: manual.id }, adapter: client })
    expect(document.body.textContent).toContain(DEFAULT_LOCK)
    expect(document.body.textContent).toContain(RETIRED_MODEL)
    expect(document.querySelector('[aria-label="Turn off llama3.3:70b"]')).toBeNull()
    expect(document.body.textContent).toContain('qwen3:4b')
    const search = document.querySelector<HTMLInputElement>('[aria-label="Search models"]')
    if (!search) throw new Error('missing search')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'qwen')
    await act(async () => search.dispatchEvent(new Event('input', { bubbles: true })))
    expect(document.body.textContent).toContain('qwen3:4b')
    expect(document.body.textContent).not.toContain('llama3.2:3b')
    expect(client.change).not.toHaveBeenCalled()
})

test('discard keeps the saved name and a failed save does not relabel the provider', async () => {
    const client = adapter()
    const { onReceipt } = await mount({ identity, adapter: client, takenNames: ['Codex'] })
    await typeInto('Name', 'Dirty name')
    await act(async () => { button('Discard').click() })
    expect(field('Name').value).toBe('Ollama')
    expect(client.change).not.toHaveBeenCalled()
    await typeInto('Name', 'Dirty name')
    client.change.mockResolvedValueOnce({ ok: false, reason: 'unavailable', message: 'Could not save this connection.' })
    await act(async () => { button('Save').click() })
    await flush()
    expect(onReceipt).not.toHaveBeenCalled()
    expect(field('Name').value).toBe('Dirty name')
    expect(document.body.textContent).toContain('Custom endpoint')
    expect(document.body.textContent).not.toContain('Codex')
})

test('a saved key stays blank and is write-only', async () => {
    const client = adapter()
    client.read.mockImplementation(async (id: CustomProviderIdentity) => ({ ok: true, value: snapshot({ revision: id.revision, configuredSecret: true }) }))
    const { onReceipt } = await mount({ identity, adapter: client })
    const secret = field('API key')
    expect(secret.value).toBe('')
    expect(secret.type).toBe('password')
    expect(document.body.textContent).toContain('Saved keys stay hidden.')
    expect(document.body.textContent).not.toContain('sk-live-secret')
    await typeInto('Name', 'Ollama local')
    await act(async () => { button('Save').click() })
    await flush()
    const saved = client.change.mock.calls[0]?.[0] as CustomProviderChange
    expect(saved.action).toBe('update')
    if (saved.action === 'update') expect(saved.apiKey).toBeUndefined()
    await typeInto('API key', 'sk-new-key')
    await act(async () => { button('Save').click() })
    await flush()
    const replaced = client.change.mock.calls.at(-1)?.[0] as CustomProviderChange
    if (replaced.action === 'update') expect(replaced.apiKey).toBe('sk-new-key')
    expect(field('API key').value).toBe('')
    expect(onReceipt).toHaveBeenCalled()
})

test('a late probe cannot replace a newer endpoint', async () => {
    let resolveProbe: (value: { ok: true; value: CustomProviderProbe }) => void = () => {}
    const client = adapter()
    client.probe.mockImplementation(() => new Promise(resolve => { resolveProbe = resolve }))
    await mount({ identity, adapter: client })
    await act(async () => { button('Retry').click() })
    await typeInto('Base URL', 'http://127.0.0.1:11434/v1')
    await blur('Base URL')
    await act(async () => { resolveProbe({ ok: true, value: probe({ status: 'fresh', problem: null, models: [{ id: 'stale-model', contextWindow: 8192, vision: false, source: 'discovered' }], manualModel: null, manualUsable: false }) }) })
    await flush()
    expect(document.body.textContent).not.toContain('stale-model')
    expect(field('Base URL').value).toBe('http://127.0.0.1:11434/v1')
})

test('workspace switch drops an in-flight probe and disconnect does not pick another provider', async () => {
    let resolveProbe: (value: { ok: true; value: CustomProviderProbe }) => void = () => {}
    const client = adapter()
    client.probe.mockImplementation(() => new Promise(resolve => { resolveProbe = resolve }))
    const { rerender, onReceipt } = await mount({ identity, adapter: client })
    await act(async () => { button('Retry').click() })
    await rerender({ workspaceId: 2 })
    await act(async () => { resolveProbe({ ok: true, value: probe({ status: 'fresh', problem: null, models: [{ id: 'stale-model', contextWindow: 8192, vision: false, source: 'discovered' }], manualModel: null, manualUsable: false }) }) })
    await flush()
    expect(document.body.textContent).toContain(OTHER_WORKSPACE)
    expect(document.body.textContent).not.toContain('stale-model')
    await rerender({ workspaceId: 1, identity })
    await act(async () => { button('Disconnect Ollama').click() })
    await act(async () => { button('Disconnect').click() })
    await flush()
    const sent = client.change.mock.calls.map(call => call[0])
    expect(sent.some(body => body.action === 'disconnect')).toBe(true)
    expect(JSON.stringify(sent)).not.toContain('codex')
    expect(JSON.stringify(onReceipt.mock.calls)).not.toContain('nextProvider')
    expect(onReceipt).toHaveBeenCalled()
})

test('back returns focus to the settings control that opened the page', async () => {
    const opener = document.createElement('button')
    opener.id = 'desktop-provider'
    document.body.appendChild(opener)
    const focus = vi.spyOn(opener, 'focus')
    const { onBack } = await mount({ returnFocusId: 'desktop-provider' })
    await act(async () => { button('Back to AI providers').click() })
    expect(onBack).toHaveBeenCalled()
    expect(focus).toHaveBeenCalled()
})
