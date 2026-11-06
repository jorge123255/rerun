import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { DesktopBrainSemanticSearchResult } from '@rerun/contracts'
import { readAgentConfig } from '../../agents/loader.js'
import type { RunContext } from '../../runtime/context.js'
import { assertDesktopAgentNotDeleted, beginDesktopAgentWork } from '../agent-lifecycle.js'
import { desktopBrainToolsAllowed } from '../brain-tools.js'
import { createDesktopBrainSemanticIndex } from './service.js'
import { desktopBrainSemanticIndex } from './runtime.js'
import { getDesktopBrainStore } from '../brain-pages-router.js'

const EXCERPT_CHARS = 600
const TURNED_OFF = 'This tool is turned off for this coworker.'

function excerpt(text: string): string {
    return text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS - 3)}...` : text
}

export function desktopBrainSemanticTools(ctx: RunContext, ports?: Parameters<typeof createDesktopBrainSemanticIndex>[0]): ToolSet {
    if (!desktopBrainToolsAllowed(ctx.agent.config)) return {}
    const service = ports ? createDesktopBrainSemanticIndex(ports) : null

    async function requireBrain(signal?: AbortSignal) {
        signal?.throwIfAborted()
        ctx.abortSignal?.throwIfAborted()
        assertDesktopAgentNotDeleted(ctx.agent.id)
        const current = await readAgentConfig(ctx.agent.id).catch(() => null)
        signal?.throwIfAborted()
        ctx.abortSignal?.throwIfAborted()
        if (!desktopBrainToolsAllowed(current)) throw new Error(TURNED_OFF)
    }

    return {
        brain_search: tool({
            description: 'Search the company brain by meaning and keywords. Returns the best passages of each matching page and linked pages. Semantic results depend on the current embedding index; keyword fallback is explicit. brain_read a page to get all of it.',
            inputSchema: z.object({ query: z.string().min(1).max(8192), limit: z.number().int().positive().max(10).default(5) }),
            execute: async ({ query, limit }, options) => {
                const release = beginDesktopAgentWork(ctx.agent.id)
                try {
                    const signal = AbortSignal.any([...(ctx.abortSignal ? [ctx.abortSignal] : []), ...(options.abortSignal ? [options.abortSignal] : [])])
                    await requireBrain(signal)
                    const result: DesktopBrainSemanticSearchResult = await (service ?? await desktopBrainSemanticIndex(ctx.agent.id, signal)).search({ query, limit: limit ?? 5 }, signal)
                    await requireBrain(signal)
                    if (result.hits.length === 0) return `Nothing in the company brain matches. It may simply not be written down yet.\n\nSearch mode: ${result.index.mode}; indexing: ${result.index.message}`
                    const pages = await Promise.all(result.hits.map(async hit => {
                        if (ports) return ports.pages.read(hit.slug)
                        return (await (await getDesktopBrainStore()).readPage(hit.slug)).page
                    }))
                    await requireBrain(signal)
                    const blocks = result.hits.map((hit, index) => {
                        const unconfirmed = new Set(pages[index]?.unconfirmed ?? [])
                        const passages = hit.passages.map(passage => `  > ${passage.heading}${unconfirmed.has(passage.heading) ? ' (unconfirmed)' : ''}: ${excerpt(passage.content)}`)
                        return [`[[${hit.slug}]] ${hit.title} (${hit.type})`, ...passages].join('\n')
                    })
                    const relatedLine = result.related.length ? `\n\nLinked pages: ${result.related.map(item => `[[${item.slug}]] ${item.title}`).join(', ')}` : ''
                    return `${blocks.join('\n\n')}${relatedLine}\n\nSearch mode: ${result.index.mode}; indexing: ${result.index.message}`
                } finally { release() }
            },
        }),
    }
}
