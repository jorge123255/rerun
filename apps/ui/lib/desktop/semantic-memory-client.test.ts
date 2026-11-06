import { afterEach, expect, it, vi } from 'vitest'
import { desktopSemanticPanelRecall, desktopSemanticRecallRequestSchema, desktopSemanticRecallResultSchema, type DesktopSemanticRecallResult } from '@rerun/contracts'
import { createDesktopSemanticMemoryClient } from './semantic-memory-client'
import { reduceSemanticMemoryPanel, semanticMemoryPanelState, semanticMemoryStatusCopy } from '@/components/desktop/semantic-memory/state'

afterEach(() => vi.unstubAllGlobals())

const result: DesktopSemanticRecallResult = {
    mode: 'keyword-only',
    detail: 'Keyword search only. An embedding backend is not configured.',
    memories: [],
    index: { mode: 'keyword-only', backend: null, indexed: 0, pending: 0, omitted: 0, detail: 'Keyword search only. An embedding backend is not configured.' },
}

it('forces panel recall to none and rejects a path on the result', () => {
    const parsed = desktopSemanticRecallRequestSchema.parse({ query: 'badge', reinforce: 'full' })
    expect(desktopSemanticPanelRecall(parsed).reinforce).toBe('none')
    expect(desktopSemanticRecallResultSchema.safeParse({ ...result, path: '/tmp/secret' }).success).toBe(false)
    expect(semanticMemoryStatusCopy(true, 'badge', 0)).toBe('Searching memories…')
    expect(semanticMemoryStatusCopy(false, 'badge', 1)).toBe('1 recalled for "badge"')
})

it('sends a read-only recall body and ignores a late response after dispose', async () => {
    const bodies: unknown[] = []
    let finish: ((value: Response) => void) | undefined
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)))
        return new Promise<Response>(resolve => { finish = resolve })
    }))
    const client = createDesktopSemanticMemoryClient('owner-a')
    const pending = client.recall('badge', false)
    const refusal = expect(pending).rejects.toThrow('Semantic recall was cancelled.')
    client.dispose()
    finish?.(Response.json(result))
    await refusal
    expect(bodies).toEqual([{ query: 'badge', limit: 5, includeDormant: false }])
    expect(JSON.stringify(bodies[0])).not.toContain('reinforce')
})

it('keeps the current recall when a stale owner response arrives', () => {
    const first = reduceSemanticMemoryPanel(semanticMemoryPanelState('owner-a'), { type: 'query', query: 'badge', ticket: 1 })
    const loading = reduceSemanticMemoryPanel(first, { type: 'start', ticket: 1, ownerId: 'owner-a', query: 'badge' })
    const ready = reduceSemanticMemoryPanel(loading, { type: 'success', ticket: 1, ownerId: 'owner-a', query: 'badge', result })
    const nextOwner = reduceSemanticMemoryPanel(ready, { type: 'owner', ownerId: 'owner-b', ticket: 2 })
    const stale = reduceSemanticMemoryPanel(nextOwner, { type: 'success', ticket: 1, ownerId: 'owner-a', query: 'badge', result: { ...result, detail: 'stale' } })
    expect(stale).toEqual(nextOwner)
    expect(stale.result).toBeNull()
    expect(stale.ownerId).toBe('owner-b')
})
