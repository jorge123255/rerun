import 'server-only'

import type { DesktopBrainSemanticAuthority, DesktopBrainSemanticIndexStatus, DesktopBrainSemanticPage, DesktopBrainSemanticSearchResult } from '@rerun/contracts'
import { createDesktopBrainSemanticIndex } from '../../../../../engine/src/desktop/brain-semantic/service'
import { desktopAuxiliaryBackends, DESKTOP_EMBEDDING_IDENTITY } from '../auxiliary/backends'
import { desktopAuxiliaryStore } from '../auxiliary/store'
import { openDesktopDatabase } from '../database'
import type { DesktopRuntime } from '../runtime'
import { getDesktopBrainStore } from './brain-pages-router'
import { desktopBrainSemanticStore } from './store'

export function createDesktopBrainSemanticServer(runtime: DesktopRuntime, authority: DesktopBrainSemanticAuthority) {
    async function portsOf() {
        const db = await openDesktopDatabase(runtime.dataRoot)
        const pages = await getDesktopBrainStore()
        const credentials = desktopAuxiliaryStore(db)
        const backend = desktopAuxiliaryBackends(credentials)
        const store = desktopBrainSemanticStore(db)
        const configuration = (await credentials.list()).find(value => value.purpose === 'embedding')
        return {
            pages: {
                async list(): Promise<DesktopBrainSemanticPage[]> {
                    const summaries = await pages.listPages()
                    return Promise.all(summaries.map(async summary => (await pages.readPage(summary.slug)).page))
                },
                read: async (slug: string) => (await pages.readPage(slug)).page,
                search: (query: string, limit: number) => pages.search(query, limit),
            },
            embedding: {
                identity: () => {
                    const configuration = credentials.list().find(value => value.purpose === 'embedding')
                    return configuration?.configured ? { model: DESKTOP_EMBEDDING_IDENTITY.model, version: DESKTOP_EMBEDDING_IDENTITY.version, dimensions: DESKTOP_EMBEDDING_IDENTITY.dimensions, revision: configuration.revision } : null
                },
                embed: (texts: readonly string[], signal: AbortSignal, revision?: string) => backend.embed(texts, signal, revision),
            },
            store,
            authority,
        }
    }

    return {
        ports: portsOf,
        async reconcile(embed = false): Promise<DesktopBrainSemanticIndexStatus> {
            const service = createDesktopBrainSemanticIndex(await portsOf())
            return service.reconcile(embed)
        },
        async search(query: string, limit?: number): Promise<DesktopBrainSemanticSearchResult> {
            const service = createDesktopBrainSemanticIndex(await portsOf())
            return service.search({ query, limit })
        },
        async status(): Promise<DesktopBrainSemanticIndexStatus> {
            const service = createDesktopBrainSemanticIndex(await portsOf())
            return service.status()
        },
        async invalidate(slug: string, expectedHash?: string): Promise<void> {
            const service = createDesktopBrainSemanticIndex(await portsOf())
            return service.invalidate(slug, expectedHash)
        },
    }
}
