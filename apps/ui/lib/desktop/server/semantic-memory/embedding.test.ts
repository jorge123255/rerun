import { beforeEach, expect, test, vi } from 'vitest'

const state = vi.hoisted(() => ({ owner: true, enabled: true, configured: true, revision: '11111111-1111-4111-8111-111111111111', embed: vi.fn(), authenticate: vi.fn() }))
vi.mock('../auth', () => ({ authenticateDesktopEngineRequest: (...args: unknown[]) => state.authenticate(...args) }))
vi.mock('../database', () => ({ openDesktopDatabase: async () => ({ execute: async () => ({ rows: state.owner ? [{ id: 'local-owner', enabled: state.enabled ? 1 : 0 }] : [] }) }) }))
vi.mock('../auxiliary/store', () => ({ desktopAuxiliaryStore: () => ({ list: async () => [{ purpose: 'embedding', revision: state.revision, configured: state.configured }] }) }))
vi.mock('../auxiliary/backends', () => ({ DESKTOP_EMBEDDING_IDENTITY: { backendId: 'fixture', model: 'fixture', version: '1', dimensions: 2 }, desktopAuxiliaryBackends: () => ({ embed: (...args: unknown[]) => state.embed(...args) }) }))
import { handleDesktopMemoryEmbedding } from './embedding'

beforeEach(() => {
    state.owner = true; state.enabled = true; state.configured = true
    state.revision = '11111111-1111-4111-8111-111111111111'
    state.authenticate.mockReset().mockResolvedValue({ dataRoot: '/fixture' })
    state.embed.mockReset().mockResolvedValue([[1, 0]])
})
function request(body: unknown) { return new Request('http://localhost/api/desktop/internal/semantic-memory', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) }
const input = () => ({ operation: 'embed', engineAgentId: 'engine-owner', revision: state.revision, texts: ['A saved note'] })

test('configuration returns identity and revision, without reading or exposing a key or calling embedding', async () => {
    const response = await handleDesktopMemoryEmbedding(request({ operation: 'configuration', engineAgentId: 'engine-owner' }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ identity: { backendId: 'fixture', model: 'fixture', version: '1', dimensions: 2 }, revision: state.revision })
    expect(state.authenticate).toHaveBeenCalledOnce()
    expect(state.embed).not.toHaveBeenCalled()
})

test('missing owner, disabled owner, old configuration and oversized text are rejected before embedding', async () => {
    state.owner = false
    expect((await handleDesktopMemoryEmbedding(request(input()))).status).toBe(400)
    state.owner = true; state.enabled = false
    expect((await handleDesktopMemoryEmbedding(request(input()))).status).toBe(400)
    state.enabled = true
    expect((await handleDesktopMemoryEmbedding(request({ ...input(), revision: '22222222-2222-4222-8222-222222222222' }))).status).toBe(400)
    expect((await handleDesktopMemoryEmbedding(request({ ...input(), texts: ['x'.repeat(8193)] }))).status).toBe(400)
    expect(state.embed).not.toHaveBeenCalled()
})

test('an owner removed while embedding is pending never receives vectors', async () => {
    state.embed.mockImplementation(async () => { state.owner = false; return [[1, 0]] })
    const response = await handleDesktopMemoryEmbedding(request(input()))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Memory indexing is unavailable.' })
})

test('normal embedding carries the exact configured revision and caller cancellation signal', async () => {
    const response = await handleDesktopMemoryEmbedding(request(input()))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ vectors: [[1, 0]] })
    expect(state.embed).toHaveBeenCalledExactlyOnceWith(['A saved note'], expect.any(AbortSignal), state.revision)
})
