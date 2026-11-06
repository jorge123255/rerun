import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'
import { z } from 'zod'
import { DESKTOP_SEMANTIC_DETAIL, desktopSemanticBackendIdentitySchema, type DesktopSemanticCanonicalNote, type DesktopSemanticEmbeddingPort, type DesktopSemanticIndexStatus, type DesktopSemanticRecallRequest } from '@rerun/contracts'
import { readAgentConfig } from '../../agents/loader.js'
import { dataDir } from '../../config/paths.js'
import { memoryStatus } from '../../memory/decay.js'
import { desktopDeletionActive } from '../agent-lifecycle.js'
import { desktopInternalJson } from '../internal-client.js'
import { listDesktopMemory, recallDesktopMemory, reinforceDesktopMemories } from '../memory-store.js'
import { desktopMemoryPaths } from '../memory-paths.js'
import { desktopApp } from '../policy.js'
import { createDesktopSemanticEmbedder } from './embed-adapter.js'
import { observeDesktopMemoryChanges } from './events.js'
import { createFileSemanticIndexStore } from './index-store.js'
import { createDesktopSemanticMemory } from './service.js'

const configSchema = z.strictObject({ identity: desktopSemanticBackendIdentitySchema.nullable(), revision: z.string().min(1).max(64) })
type Configuration = z.infer<typeof configSchema>
type Service = ReturnType<typeof createDesktopSemanticMemory>
type Entry = { service: Service; configuration: Configuration | null; refresh(signal?: AbortSignal): Promise<void> }
const roots = new Map<string, { store: ReturnType<typeof createFileSemanticIndexStore>; entries: Map<string, Entry> }>()
const lifecycle = new AbortController()
const background = new Set<Promise<unknown>>()
let closed = false

function keywordStatus(current: Entry): DesktopSemanticIndexStatus {
    return { mode: 'keyword-only', backend: null, indexed: 0, pending: 0, omitted: 0,
        detail: current.configuration ? DESKTOP_SEMANTIC_DETAIL.unconfigured : DESKTOP_SEMANTIC_DETAIL.unavailable }
}

async function canonicalNotes(agentId: string): Promise<DesktopSemanticCanonicalNote[]> {
    const [files, rows] = await listDesktopMemory(agentId)
    const stats = new Map(rows.map(row => [row.id, row]))
    return files.filter(file => /^[A-Za-z0-9_-]{1,128}$/.test(file.id) && basename(file.path) === `${file.id}.md`).map(file => {
        const current = stats.get(file.id)
        return { id: file.id, content: file.content, kind: file.kind, tags: file.tags, createdAt: current?.createdAt ?? file.createdAt,
            lastAccessedAt: current?.lastAccessedAt ?? null, accessCount: current?.accessCount ?? 0 }
    })
}

function entry(agentId: string): Entry {
    if (!desktopApp() || closed || !/^[A-Za-z0-9_-]{1,128}$/.test(agentId)) throw new Error('Coworker memories are unavailable')
    const root = dataDir()
    let state = roots.get(root)
    if (!state) { state = { store: createFileSemanticIndexStore(join(root, 'desktop-semantic-memory')), entries: new Map() }; roots.set(root, state) }
    const existing = state.entries.get(agentId)
    if (existing) return existing
    let configuration: Configuration | null = null
    const embedding: DesktopSemanticEmbeddingPort = {
        identity: () => configuration?.identity ?? null,
        embed: async (texts, signal, deadline) => {
            const bound = configuration
            return createDesktopSemanticEmbedder(bound?.identity ? {
                identity: bound.identity,
                embed: async (input, stop) => {
                    const result = await desktopInternalJson('/api/desktop/internal/semantic-memory', { operation: 'embed', engineAgentId: agentId, texts: input, revision: bound.revision }, stop, 1_500_000)
                    if (configuration?.revision !== bound.revision) return 'refused'
                    return z.strictObject({ vectors: z.array(z.array(z.number().finite()).length(bound.identity!.dimensions)).length(input.length) }).parse(result).vectors
                },
            } : null).embed(texts, signal, deadline)
        },
    }
    const service = createDesktopSemanticMemory({
        store: state.store, embedding,
        owners: { requireCurrentOwner: async id => {
            if (id !== agentId || closed || desktopDeletionActive(id)) return null
            const config = await readAgentConfig(id).catch(() => null)
            if (!config?.enabled || desktopDeletionActive(id)) return null
            await desktopMemoryPaths(id)
            return { localAgentId: id }
        } },
        notes: {
            listNotes: canonicalNotes,
            readNote: async (id, noteId) => (await canonicalNotes(id)).find(note => note.id === noteId) ?? null,
            generation: async id => createHash('sha256').update(JSON.stringify((await canonicalNotes(id)).map(note => [note.id, note.content, note.createdAt]).sort((a, b) => a[0]!.localeCompare(b[0]!)))).digest('hex'),
        },
        onReinforce: (id, ids, mode) => reinforceDesktopMemories(id, ids, mode),
    })
    const result: Entry = {
        service, get configuration() { return configuration },
        async refresh(signal) {
            const stop = AbortSignal.any([lifecycle.signal, ...(signal ? [signal] : []), AbortSignal.timeout(5_000)])
            try {
                const next = configSchema.parse(await desktopInternalJson('/api/desktop/internal/semantic-memory', { operation: 'configuration', engineAgentId: agentId }, stop, 4096))
                if (configuration?.revision !== next.revision) await service.cancel(agentId)
                configuration = next
            } catch { configuration = null }
            signal?.throwIfAborted()
        },
    }
    state.entries.set(agentId, result)
    return result
}

export async function recallSemanticDesktopMemory(agentId: string, request: DesktopSemanticRecallRequest, signal?: AbortSignal) {
    if (desktopDeletionActive(agentId)) throw new Error('Coworker memories are unavailable')
    const current = entry(agentId)
    await current.refresh(signal)
    if (!current.configuration?.identity) {
        signal?.throwIfAborted()
        const memories = await recallDesktopMemory(agentId, request.query, request.limit, { includeDormant: request.includeDormant })
        signal?.throwIfAborted()
        const index = keywordStatus(current)
        const [fresh] = await listDesktopMemory(agentId)
        signal?.throwIfAborted()
        if (closed || desktopDeletionActive(agentId)) throw new Error('Coworker memories are unavailable')
        return { mode: 'keyword-only' as const, detail: index.detail, index, memories: memories.filter(note => fresh.some(current => current.id === note.id && current.content === note.content)).map(note => ({ ...note, status: memoryStatus(note.strength) })) }
    }
    await current.service.reconcile(agentId, signal)
    return current.service.recall(agentId, request, signal)
}

export async function semanticDesktopMemoryStatus(agentId: string, signal?: AbortSignal) {
    const current = entry(agentId)
    await current.refresh(signal)
    if (!current.configuration?.identity) {
        await desktopMemoryPaths(agentId)
        signal?.throwIfAborted()
        if (desktopDeletionActive(agentId)) throw new Error('Coworker memories are unavailable')
        return keywordStatus(current)
    }
    return current.service.status(agentId, signal)
}

export async function maintainSemanticDesktopMemory(agentId: string, operation: 'retry' | 'reconcile', signal?: AbortSignal) {
    const current = entry(agentId)
    await current.refresh(signal)
    if (!current.configuration?.identity) return semanticDesktopMemoryStatus(agentId, signal)
    await current.service[operation](agentId, signal)
    return current.service.status(agentId, signal)
}

export function invalidateDesktopSemanticMemory(agentId: string) {
    const current = roots.get(dataDir())?.entries.get(agentId)
    if (current) void current.service.cancel(agentId).catch(() => {})
}

observeDesktopMemoryChanges(change => {
    if (!desktopApp() || closed) return
    if (change.phase === 'before') { invalidateDesktopSemanticMemory(change.agentId); return }
    // Queue after the canonical store releases its lock; indexing never changes the saved note outcome.
    const work = Promise.resolve().then(async () => {
        const current = entry(change.agentId)
        await current.refresh()
        await current.service.reconcile(change.agentId)
    }).catch(() => {})
    background.add(work)
    void work.then(() => background.delete(work))
})

export async function shutdownDesktopSemanticMemory() {
    closed = true
    lifecycle.abort()
    await Promise.allSettled([...roots.values()].flatMap(state => [...state.entries.values()].map(value => value.service.shutdown())))
    await Promise.allSettled([...background])
}
