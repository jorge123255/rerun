import { beforeEach, expect, test, vi } from 'vitest'
import { agentConfigSchema } from '../agents/types.js'
import type { RunContext } from '../runtime/context.js'

const state = vi.hoisted(() => ({ config: null as unknown, recall: vi.fn(), reinforce: vi.fn() }))
vi.mock('../agents/loader.js', () => ({ readAgentConfig: async () => state.config }))
vi.mock('./semantic-memory/runtime.js', () => ({ recallSemanticDesktopMemory: (...args: unknown[]) => state.recall(...args) }))
vi.mock('./memory-store.js', () => ({ addDesktopMemory: vi.fn(), updateDesktopMemory: vi.fn(), removeDesktopMemory: vi.fn(), reinforceDesktopMemories: (...args: unknown[]) => state.reinforce(...args) }))
import { desktopMemoryTools } from './memory-tools.js'

beforeEach(() => {
    state.config = agentConfigSchema.parse({ name: 'owner', tools: { desktopToolGrants: { memoryRecall: true } } })
    state.recall.mockReset()
    state.reinforce.mockReset().mockResolvedValue(undefined)
})
function recall(signal?: AbortSignal) {
    const tools = desktopMemoryTools({ agent: { id: 'owner', config: state.config }, abortSignal: signal } as RunContext)
    return () => tools.memory_recall!.execute!({ query: 'location', limit: 5, includeDormant: false }, { toolCallId: 'call', messages: [] })
}
const result = { memories: [{ id: 'note', kind: 'fact', content: 'Printer by the cabinet' }] }

test('model recall passes cancellation, then strengthens only returned owner note IDs', async () => {
    const signal = new AbortController().signal
    state.recall.mockResolvedValue(result)
    expect(await recall(signal)()).toContain('[note] (fact) Printer by the cabinet')
    expect(state.recall).toHaveBeenCalledExactlyOnceWith('owner', { query: 'location', limit: 5, includeDormant: false, reinforce: 'none' }, signal)
    expect(state.reinforce).toHaveBeenCalledExactlyOnceWith('owner', ['note'], 'full')
})

test('grant revoked during asynchronous recall prevents both return and reinforcement', async () => {
    state.recall.mockImplementation(async () => {
        state.config = agentConfigSchema.parse({ name: 'owner', tools: { desktopToolGrants: { memoryRecall: false } } })
        return result
    })
    await expect(recall()()).rejects.toThrow(/turned off/)
    expect(state.reinforce).not.toHaveBeenCalled()
})

test('Stop during asynchronous recall prevents reinforcement', async () => {
    const stop = new AbortController()
    state.recall.mockImplementation(async () => { stop.abort(); return result })
    await expect(recall(stop.signal)()).rejects.toThrow()
    expect(state.reinforce).not.toHaveBeenCalled()
})
