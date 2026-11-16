// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { CustomProviderModel, DesktopOllamaKind } from '@rerun/contracts'
import type { OllamaAdapter } from '@/lib/desktop/ollama'
import { DesktopOllamaSettings, desktopOllamaConnection, useDesktopOllama } from './DesktopOllamaSettings'

const roots: Root[] = []
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterEach(async () => {
    await act(async () => { for (const root of roots.splice(0)) root.unmount() })
    document.body.innerHTML = ''
})

const chat: CustomProviderModel = { id: 'synthetic-chat:latest', contextWindow: null, vision: true, source: 'discovered', tools: true }
const plain: CustomProviderModel = { id: 'synthetic-plain:7b', contextWindow: null, vision: false, source: 'discovered', tools: false }
const syntheticKey = 'synthetic-only-ollama-key'
type Connection = Parameters<typeof useDesktopOllama>[0]['connections'][number]
const cloudConnection: Connection = { id: '44444444-4444-4444-8444-444444444444', name: 'Ollama Cloud', provider: 'custom', baseUrl: 'https://ollama.com/v1', customRevision: 1 }

function adapter(running: boolean) {
    const probeDraft = vi.fn<OllamaAdapter['probeDraft']>(async draft => ({ ok: true, value: { requestId: draft.requestId, workspaceId: draft.workspaceId,
        status: running ? 'fresh' : 'unavailable', models: running ? [chat, plain] : [], problem: running ? null : 'unreachable',
        manualModel: draft.manualModel ?? null, manualUsable: !!draft.manualModel, observedAt: 1 } }))
    const change = vi.fn<OllamaAdapter['change']>(async body => ({ ok: true, value: { requestId: body.requestId, action: body.action, status: 'recorded', recovered: false,
        identity: body.action === 'create' ? { workspaceId: body.workspaceId, connectionId: body.connectionId, revision: 1 } : { ...body.identity, revision: body.identity.revision + 1 } } }))
    const read = vi.fn<OllamaAdapter['read']>(async identity => ({ ok: true, value: { ...identity, configuredSecret: true, state: 'configured',
        catalog: { status: 'never', models: [], observedAt: null, attemptedAt: null },
        config: { name: 'Ollama Cloud', baseUrl: 'https://ollama.com/v1', preset: null, models: [chat], contextWindow: null, vision: false, policy: { reviewedOrigin: 'https://ollama.com', allowHttp: false, allowPrivate: false } } } }))
    const probe = vi.fn<OllamaAdapter['probe']>(async identity => ({ ok: true, value: { identity, status: 'fresh', models: [chat, plain], problem: null, manualModel: null, manualUsable: false, observedAt: 1 } }))
    return { probeDraft, change, read, probe }
}

function Harness({ kind, client, connections, onChanged }: { kind: DesktopOllamaKind; client: OllamaAdapter; connections: Connection[]; onChanged: () => void }) {
    const ollama = useDesktopOllama({ workspaceId: 1, connections, defaultModel: null, onConnectionsChanged: onChanged, adapter: client })
    return <DesktopOllamaSettings kind={kind} connected={!!desktopOllamaConnection(connections, kind)} ollama={ollama} />
}
async function flush() { for (let i = 0; i < 10; i += 1) await act(async () => { await Promise.resolve() }) }
async function mount(kind: DesktopOllamaKind, client: ReturnType<typeof adapter>, connections: Connection[] = []) {
    const root = createRoot(document.body.appendChild(document.createElement('div')))
    roots.push(root)
    const onChanged = vi.fn()
    await act(async () => root.render(<Harness kind={kind} client={client} connections={connections} onChanged={onChanged} />))
    await flush()
    return { onChanged, rerender: async (next: Connection[]) => { await act(async () => root.render(<Harness kind={kind} client={client} connections={next} onChanged={onChanged} />)); await flush() } }
}
function button(label: string) {
    const found = [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === label)
    if (!(found instanceof HTMLButtonElement)) throw new Error(`missing ${label}`)
    return found
}

test('opening Settings asks the Ollama app and shows clearly when it is not running', async () => {
    const client = adapter(false)
    await mount('ollama', client)
    expect(client.probeDraft).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[data-ollama-state="not-running"]')).toBeTruthy()
    expect(document.body.textContent).toContain('Ollama is not running on this Mac.')
    const download = [...document.querySelectorAll('a')].find(item => item.textContent === 'Download Ollama')
    expect(download?.getAttribute('href')).toBe('https://ollama.com/download')
    expect(button('Use Ollama').disabled).toBe(true)
    // The address is stated and cannot be edited.
    expect(document.body.textContent).toContain('http://127.0.0.1:11434')
    expect(document.querySelector('input')).toBeNull()
})

test('lists the running Ollama models, names the ones without tools, and connects without a key', async () => {
    const client = adapter(true)
    const { onChanged } = await mount('ollama', client)
    expect(document.body.textContent).toContain('Ollama is running · 1 model found')
    expect([...document.querySelectorAll('li')].map(item => item.textContent)).toEqual(['synthetic-chat:latestTools · Images'])
    expect(document.body.textContent).toContain('cannot call tools, which every coworker needs: synthetic-plain:7b')
    await act(async () => { button('Use Ollama').click() })
    await flush()
    expect(client.change.mock.calls[0]![0]).toMatchObject({ action: 'create', config: { name: 'Ollama (this Mac)', baseUrl: 'http://127.0.0.1:11434/v1', models: [chat] } })
    expect(client.change.mock.calls[0]![0]).not.toHaveProperty('apiKey')
    expect(onChanged).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).toContain('Ollama connected.')
})

test('saves the Ollama Cloud key without ever showing it again, and removes it', async () => {
    const client = adapter(true)
    const { onChanged, rerender } = await mount('ollama-cloud', client)
    // Nothing is asked of ollama.com until there is a key.
    expect(client.probeDraft).toHaveBeenCalledTimes(1)
    expect(client.probeDraft.mock.calls[0]![0].baseUrl).toBe('http://127.0.0.1:11434/v1')
    const input = document.querySelector('input')!
    expect(input.type).toBe('password')
    expect(input.getAttribute('autocomplete')).toBe('off')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, syntheticKey)
    await act(async () => input.dispatchEvent(new Event('input', { bubbles: true })))
    await act(async () => { button('Connect').click() })
    await flush()
    expect(client.change.mock.calls[0]![0]).toMatchObject({ action: 'create', apiKey: syntheticKey, config: { name: 'Ollama Cloud', baseUrl: 'https://ollama.com/v1' } })
    expect(onChanged).toHaveBeenCalledTimes(1)
    expect(input.value).toBe('')
    expect(document.body.innerHTML).not.toContain(syntheticKey)

    await rerender([cloudConnection])
    expect(client.probe).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).toContain('Ollama Cloud is connected · 1 model offered to coworkers and chats')
    expect(document.body.textContent).toContain('A key is saved.')
    await act(async () => { button('Remove key').click() })
    await flush()
    expect(client.change.mock.calls.at(-1)![0]).toMatchObject({ action: 'disconnect', identity: { connectionId: cloudConnection.id, revision: 1 } })
    expect(document.body.textContent).toContain('Ollama Cloud and its key removed.')
})
