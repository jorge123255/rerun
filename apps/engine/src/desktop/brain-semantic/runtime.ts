import { z } from 'zod'
import type { DesktopBrainSemanticBackend, DesktopBrainSemanticPorts, DesktopBrainSemanticPage } from '@rerun/contracts'
import { desktopBrainSemanticBackendSchema } from '@rerun/contracts'
import { getBrainDb } from '../../db/brainDb.js'
import { readAgentConfig } from '../../agents/loader.js'
import { assertDesktopAgentNotDeleted } from '../agent-lifecycle.js'
import { getDesktopBrainStore } from '../brain-pages-router.js'
import { desktopBrainToolsAllowed } from '../brain-tools.js'
import { desktopInternalJson } from '../internal-client.js'
import { HttpError } from '../../lib/errors.js'
import { desktopBrainSemanticSchema } from './schema.js'
import { desktopBrainSemanticStore } from './store.js'
import { createDesktopBrainSemanticIndex } from './service.js'

export async function initializeDesktopBrainSemanticStore() { await (await getBrainDb()).executeMultiple(desktopBrainSemanticSchema) }
export async function desktopBrainSemanticPorts(engineAgentId: string, signal: AbortSignal): Promise<DesktopBrainSemanticPorts> {
    const pages = await getDesktopBrainStore(), database = await getBrainDb()
    const authority = async (stop: AbortSignal) => {
        stop.throwIfAborted(); signal.throwIfAborted(); assertDesktopAgentNotDeleted(engineAgentId)
        if (!desktopBrainToolsAllowed(await readAgentConfig(engineAgentId).catch(() => null))) throw new Error('Company Brain is turned off for this coworker.')
        stop.throwIfAborted(); signal.throwIfAborted(); assertDesktopAgentNotDeleted(engineAgentId)
    }
    async function configuration(): Promise<DesktopBrainSemanticBackend | null> {
        await authority(signal)
        try {
            const raw = z.object({ identity: z.object({ model: z.string(), version: z.string(), dimensions: z.number() }).nullable(), revision: z.string() }).parse(await desktopInternalJson('/api/desktop/internal/semantic-memory', { operation: 'configuration', engineAgentId }, AbortSignal.any([signal, AbortSignal.timeout(5000)]), 4096))
            return raw.identity ? desktopBrainSemanticBackendSchema.parse({ ...raw.identity, revision: raw.revision }) : null
        } catch { signal.throwIfAborted(); await authority(signal); throw new Error('Embedding configuration is unavailable.') }
    }
    const read = async (slug: string): Promise<DesktopBrainSemanticPage | null> => {
        await authority(signal)
        try { const page = (await pages.readPage(slug)).page; return { slug: page.slug, title: page.title, type: page.type, hash: page.hash, content: page.content, sources: page.sources, unconfirmed: page.unconfirmed, links: page.links, updatedAt: page.updatedAt, updatedBy: page.updatedBy } }
        catch (error) { if (error instanceof HttpError && error.status === 404) return null; throw error }
    }
    return {
        pages: { async list() { const summaries = await pages.listPages(); const found = await Promise.all(summaries.map(page => read(page.slug))); return found.filter((page): page is DesktopBrainSemanticPage => page !== null) }, read, search: (query, limit) => pages.search(query, limit) },
        embedding: { identity: configuration, async embed(texts, stop, revision) {
            await authority(stop)
            const result = await desktopInternalJson('/api/desktop/internal/semantic-memory', { operation: 'embed', engineAgentId, texts: [...texts], revision }, AbortSignal.any([signal, stop, AbortSignal.timeout(10_000)]), 1_500_000)
            await authority(stop)
            return z.object({ vectors: z.array(z.array(z.number().finite())).min(1).max(16) }).parse(result).vectors
        } }, store: desktopBrainSemanticStore(database), authority,
    }
}
export async function desktopBrainSemanticIndex(engineAgentId: string, signal: AbortSignal) { return createDesktopBrainSemanticIndex(await desktopBrainSemanticPorts(engineAgentId, signal)) }
