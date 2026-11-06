import {
    FOREMAN_SEARCH_DOCS_DESCRIPTION,
    desktopForemanDocsQuerySchema,
    type DesktopForemanDocsCorpus,
    type DesktopForemanDocsRequest,
    type DesktopForemanDocsResult,
} from '@rerun/contracts'
import { tool, type ToolSet } from 'ai'
import type { DesktopForemanBinding } from '@rerun/contracts'

export type DesktopForemanDocsToolPorts = {
    binding: DesktopForemanBinding | null
    corpus: DesktopForemanDocsCorpus
    assertCurrent: () => Promise<void>
    search: ((input: DesktopForemanDocsRequest, signal?: AbortSignal) => Promise<DesktopForemanDocsResult>) | null
}

export function desktopForemanDocsTools(ports: DesktopForemanDocsToolPorts): ToolSet {
    if (!ports.binding || !ports.search) return {}
    const binding = ports.binding
    const search = ports.search
    return {
        search_docs: tool({
            description: FOREMAN_SEARCH_DOCS_DESCRIPTION,
            inputSchema: desktopForemanDocsQuerySchema,
            execute: async ({ query }, options) => {
                await ports.assertCurrent()
                const result = await search({ binding, toolCallId: options.toolCallId, query, corpus: ports.corpus }, options.signal)
                await ports.assertCurrent()
                return result
            },
        }),
    }
}
