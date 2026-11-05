import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopSetupView } from '@rerun/contracts'
import { createDesktopSetupClient } from './setup-client'

afterEach(() => vi.unstubAllGlobals())

function view(overrides: Partial<DesktopSetupView> = {}): DesktopSetupView {
    return {
        agentId: 'owner', revision: 'revision-1', required: true, prompt: 'Set up locally', completedAt: null,
        sessionId: null, pending: true, skipped: false, defaultPrompt: 'Safe Mac prompt', ...overrides,
    }
}

it('retains the exact mutation UUID and author text after an unknown acknowledgment', async () => {
    const sent: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        sent.push(JSON.parse(String(init.body)))
        throw new Error('response lost')
    }))
    const client = createDesktopSetupClient('owner')
    const current = view()
    const draft = { required: true, prompt: 'Keep this entered text' }
    await expect(client.save(current, draft)).rejects.toThrow()
    await expect(client.save(current, draft)).rejects.toThrow()
    expect(sent).toHaveLength(2)
    expect(sent[0].requestId).toBe(sent[1].requestId)
    expect(sent[0].prompt).toBe('Keep this entered text')
    expect(sent[0].expectedRevision).toBe('revision-1')
    client.dispose()
})

it('reopening reads server progress without repeating Start', async () => {
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => Response.json(view({ sessionId: 'claimed-chat' })))
    vi.stubGlobal('fetch', fetcher)
    const client = createDesktopSetupClient('owner')
    await expect(client.read()).resolves.toMatchObject({ sessionId: 'claimed-chat' })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'GET' })
    client.dispose()
})

it('continues the already claimed chat with its exact revision', async () => {
    const sent: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        sent.push(JSON.parse(String(init.body)))
        return Response.json({ view: view({ sessionId: 'claimed-chat' }), sessionId: 'claimed-chat' })
    }))
    const client = createDesktopSetupClient('owner')
    await client.continueSetup(view({ sessionId: 'claimed-chat' }))
    expect(sent[0]).toMatchObject({ action: 'continue', expectedRevision: 'revision-1' })
    expect(sent[0].requestId).toEqual(expect.any(String))
    client.dispose()
})

it('retains the Start UUID when an acknowledgment omits the claimed chat', async () => {
    const sent: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        sent.push(JSON.parse(String(init.body)))
        return Response.json({ view: view() })
    }))
    const client = createDesktopSetupClient('owner')
    await expect(client.start(view())).rejects.toThrow('claimed chat')
    await expect(client.start(view())).rejects.toThrow('claimed chat')
    expect(sent[0].requestId).toBe(sent[1].requestId)
    client.dispose()
})

it('refuses a mutation acknowledgment for another coworker', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ view: view({ agentId: 'other', revision: 'revision-2' }) })))
    const client = createDesktopSetupClient('owner')
    await expect(client.skip(view())).rejects.toThrow('another coworker')
    client.dispose()
})

it('aborts a pending read when the owner changes', async () => {
    let finish!: (value: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve })))
    const client = createDesktopSetupClient('owner')
    const pending = client.read()
    const refusal = expect(pending).rejects.toThrow('owner changed')
    client.dispose()
    finish(Response.json(view()))
    await refusal
})
