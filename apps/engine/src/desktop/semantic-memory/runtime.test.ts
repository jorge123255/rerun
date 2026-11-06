import { beforeEach, expect, test, vi } from 'vitest'

const state = vi.hoisted(() => ({ enabled: true, deleting: false, configured: true, notes: [] as { id: string; content: string; path: string; kind: string; tags: string[]; createdAt: string }[], callback: vi.fn() }))
vi.mock('../../agents/loader.js', () => ({ readAgentConfig: async () => ({ enabled: state.enabled }) }))
vi.mock('../../config/paths.js', () => ({ dataDir: () => '/semantic-runtime-fixture' }))
vi.mock('../agent-lifecycle.js', () => ({ desktopDeletionActive: () => state.deleting }))
vi.mock('../memory-paths.js', () => ({ desktopMemoryPaths: async () => ({}) }))
vi.mock('../policy.js', () => ({ desktopApp: () => true }))
vi.mock('../internal-client.js', () => ({ desktopInternalJson: (...args: unknown[]) => state.callback(...args) }))
vi.mock('../memory-store.js', () => ({
    listDesktopMemory: async () => [[...state.notes], []],
    recallDesktopMemory: async (_id: string, query: string) => state.notes.filter(note => note.content.includes(query)).map(({ path: _path, ...note }) => ({ ...note, strength: 1 })),
    reinforceDesktopMemories: vi.fn(),
    bindDesktopMemorySemanticClear: () => {},
}))
vi.mock('./index-store.js', async original => {
    const actual = await original<typeof import('./index-store.js')>()
    return { ...actual, createFileSemanticIndexStore: () => actual.createMemorySemanticIndexStore() }
})
const identity = { backendId: 'fixture', model: 'fixture', version: '1', dimensions: 2 }
beforeEach(() => {
    vi.resetModules()
    state.enabled = true; state.deleting = false; state.configured = true
    state.notes = [{ id: 'note', content: 'The printer is by the cabinet', path: '/memory/note.md', kind: 'fact', tags: [], createdAt: new Date().toISOString() }]
    state.callback.mockReset()
    state.callback.mockImplementation(async (_path, body) => body.operation === 'configuration'
        ? { identity: state.configured ? identity : null, revision: '11111111-1111-4111-8111-111111111111' }
        : { vectors: body.texts.map(() => [1, 0]) })
})

test('unconfigured runtime retains canonical keyword notes without sending content to embedding', async () => {
    state.configured = false
    const runtime = await import('./runtime.js')
    try {
        const result = await runtime.recallSemanticDesktopMemory('owner', { query: 'printer', limit: 5, includeDormant: false, reinforce: 'none' })
        expect(result.mode).toBe('keyword-only')
        expect(result.memories.map(note => note.id)).toEqual(['note'])
        expect(state.callback.mock.calls.every(([, body]) => body.operation === 'configuration')).toBe(true)
    } finally { await runtime.shutdownDesktopSemanticMemory() }
})

test('current owned notes are indexed and a semantic query can find a non-keyword match', async () => {
    const runtime = await import('./runtime.js')
    try {
        await runtime.maintainSemanticDesktopMemory('owner', 'reconcile')
        await vi.waitFor(async () => expect((await runtime.semanticDesktopMemoryStatus('owner')).indexed).toBe(1))
        const result = await runtime.recallSemanticDesktopMemory('owner', { query: 'office equipment location', limit: 5, includeDormant: false, reinforce: 'none' })
        expect(result.mode).toBe('semantic')
        expect(result.memories.map(note => note.id)).toEqual(['note'])
        expect(state.callback.mock.calls.filter(([, body]) => body.operation === 'embed').every(([, body]) => body.engineAgentId === 'owner')).toBe(true)
        state.notes = []
        runtime.invalidateDesktopSemanticMemory('owner')
        expect((await runtime.recallSemanticDesktopMemory('owner', { query: 'office equipment location', limit: 5, includeDormant: false, reinforce: 'none' })).memories).toEqual([])
    } finally { await runtime.shutdownDesktopSemanticMemory() }
})

test('deleting the owner and Stop both prevent a delayed query from returning private notes', async () => {
    const runtime = await import('./runtime.js')
    try {
        await runtime.maintainSemanticDesktopMemory('owner', 'reconcile')
        await vi.waitFor(async () => expect((await runtime.semanticDesktopMemoryStatus('owner')).indexed).toBe(1))
        let entered!: () => void, finish!: (value: unknown) => void
        const started = new Promise<void>(resolve => { entered = resolve })
        state.callback.mockImplementation(async (_path, body) => {
            if (body.operation === 'configuration') return { identity, revision: '11111111-1111-4111-8111-111111111111' }
            entered()
            return new Promise(resolve => { finish = resolve })
        })
        const stop = new AbortController()
        const pending = runtime.recallSemanticDesktopMemory('owner', { query: 'office equipment', limit: 5, includeDormant: false, reinforce: 'none' }, stop.signal)
        await started
        state.deleting = true
        runtime.invalidateDesktopSemanticMemory('owner')
        stop.abort()
        finish({ vectors: [[1, 0]] })
        expect((await pending).memories).toEqual([])
    } finally { await runtime.shutdownDesktopSemanticMemory() }
})
