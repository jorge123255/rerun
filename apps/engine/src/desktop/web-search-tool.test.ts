import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopWebSearchPorts } from '@rerun/contracts'

const grants = vi.hoisted(() => ({ hasDesktopToolGrant: vi.fn(() => true), requireDesktopToolGrant: vi.fn(async () => {}) }))
vi.mock('./tool-grants.js', () => grants)
vi.mock('./agent-lifecycle.js', () => ({ beginDesktopAgentWork: () => () => {} }))

import { desktopWebSearchTools, webSearchDescription } from './web-search-tool'

function ports(patch: Partial<DesktopWebSearchPorts> = {}): DesktopWebSearchPorts {
    return {
        adapter: {
            generation: 'generation-1',
            search: vi.fn(async () => ({ provenance: { provider: 'fixture-search' }, results: [
                { title: 'One', url: 'https://one.example/', snippet: 'first' },
                { title: 'Two', url: 'https://two.example/', snippet: '' },
            ] })),
        },
        authority: vi.fn(async () => ({ adapterGeneration: 'generation-1' })),
        readiness: vi.fn(async () => ({ status: 'ready', message: 'Ready.', retryable: false })),
        outcomes: { begin: vi.fn(async () => 'execute'), complete: vi.fn(async () => {}) },
        ...patch,
    }
}

function ctx(signal = new AbortController().signal) {
    return {
        agent: { id: 'agent', config: { tools: {} } },
        sessionId: 'session', runId: 'run', abortSignal: signal,
    } as Parameters<typeof desktopWebSearchTools>[0]
}

async function execute(input: unknown, injected = ports(), signal = new AbortController().signal) {
    const tools = desktopWebSearchTools(ctx(signal), injected).web_search as { execute: (input: unknown, options: { toolCallId: string; abortSignal: AbortSignal }) => Promise<string> }
    return tools.execute(input, { toolCallId: 'tool-call', abortSignal: signal })
}

beforeEach(() => { grants.hasDesktopToolGrant.mockReturnValue(true) })

describe('desktop web_search tool', () => {
    it('formats original ranked title, URL and snippet rows', async () => {
        await expect(execute({ query: 'x', maxResults: 2 })).resolves.toBe('1. One\n   https://one.example/\n   first\n\n2. Two\n   https://two.example/')
    })

    it('returns No results only for an acknowledged empty response', async () => {
        const injected = ports()
        injected.adapter!.search = vi.fn(async () => ({ provenance: { provider: 'fixture-search' }, results: [] }))
        await expect(execute({ query: 'nothing' }, injected)).resolves.toBe('No results.')
    })

    it('keeps unavailable and failure outcomes distinct from empty results', async () => {
        await expect(execute({ query: 'x' }, ports({ adapter: null }))).resolves.toContain('Search failed: Web search is unavailable')
    })

    it('does not expose paid-data guidance in the Mac description', () => {
        expect(webSearchDescription).not.toContain('paid_data')
        expect(webSearchDescription).toContain('ranked results (title, URL, snippet)')
    })

    it('returns no Rerun tool when the independent grant is off', () => {
        grants.hasDesktopToolGrant.mockReturnValue(false)
        expect(desktopWebSearchTools(ctx(), ports())).toEqual({})
    })

    it('rejects invalid input before any backend effect', async () => {
        const injected = ports()
        await expect(execute({ query: 'x', maxResults: 21 }, injected)).rejects.toThrow()
        expect(injected.adapter!.search).not.toHaveBeenCalled()
        expect(injected.outcomes.begin).not.toHaveBeenCalled()
    })

    it('throws cancellation rather than converting it into an empty or failed search result', async () => {
        const injected = ports()
        injected.adapter!.search = vi.fn(() => new Promise(() => {}))
        const controller = new AbortController()
        controller.abort(new Error('Stopped'))
        await expect(execute({ query: 'x' }, injected, controller.signal)).rejects.toThrow()
    })
    it.each(['context', 'tool'] as const)('honors cancellation from the %s signal when both are present', async source => {
        const context = new AbortController(), invocation = new AbortController()
        const injected = ports()
        injected.adapter!.search = vi.fn(() => new Promise(() => {}))
        const tools = desktopWebSearchTools(ctx(context.signal), injected).web_search as { execute: (input: unknown, options: { toolCallId: string; abortSignal: AbortSignal }) => Promise<string> }
        const pending = tools.execute({ query: 'x' }, { toolCallId: 'tool-call', abortSignal: invocation.signal })
        const result = expect(pending).rejects.toThrow('Search cancelled by run.')
        await vi.waitFor(() => expect(injected.adapter!.search).toHaveBeenCalledOnce())
        ;(source === 'context' ? context : invocation).abort()
        await result
    })

})
