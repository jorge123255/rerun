import { realpath } from 'node:fs/promises'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { brainProposalInputSchema } from '@rerun/contracts'
import { readAgentConfig } from '../agents/loader.js'
import { dataDir } from '../config/paths.js'
import type { RunContext } from '../runtime/context.js'
import { assertDesktopAgentNotDeleted, beginDesktopAgentWork } from './agent-lifecycle.js'
import {
    desktopBrainPageHash,
    desktopBrainProposalFingerprint,
    DesktopBrainProposalError,
    findDesktopBrainProposalByFingerprint,
    insertDesktopBrainProposal,
    listDesktopBrainPages,
    openDesktopBrainProposalFor,
    readDesktopBrainPage,
    replaceDesktopBrainProposal,
    resolveDesktopBrainEngineDirectory,
    searchDesktopBrain,
    type DesktopBrainPageFile,
} from './brain-proposals.js'

// Desktop brain_read, brain_search, and brain_propose. brain_write is not registered.
// Arguments cannot name a root, a host path, an engine id, or a private memory.

const TURNED_OFF = 'This tool is turned off for this coworker.'
const PROPOSED = 'Sent for review. A person accepts or dismisses it from the Brain; until then the page is unchanged, so do not tell the user it is saved. Mention it in one short sentence at most.'
const UPDATED = 'Replaced your change still waiting for review on this page. Mention it in one short sentence at most.'
const ALREADY = 'This exact change was already proposed once. Nothing sent, and do not raise it again.'
const EXCERPT_CHARS = 600
const UNCONFIRMED_NOTE = 'imported from the public web, nobody at the company confirmed them'

type BrainGrantConfig = {
    enabled?: boolean
    tools?: { brain?: boolean; desktopToolGrants?: object }
}

function brainGrant(config: BrainGrantConfig): boolean {
    const grants = config.tools?.desktopToolGrants as Record<string, boolean> | undefined
    return grants?.brain === true
}

export function desktopBrainToolsAllowed(config: BrainGrantConfig | null | undefined): boolean {
    if (!config?.enabled) return false
    if (config.tools?.brain === false) return false
    return brainGrant(config)
}

function isAbort(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError'
}

const excerpt = (text: string, max = EXCERPT_CHARS) => (text.length > max ? `${text.slice(0, max - 3)}...` : text)

function proposalResult(status: 'proposed' | 'updated', proposalId: string, slug: string, title: string, message: string): string {
    return JSON.stringify({ status, proposalId, slug, title, message })
}

async function requireBrain(ctx: RunContext, signal?: AbortSignal) {
    signal?.throwIfAborted()
    ctx.abortSignal?.throwIfAborted()
    assertDesktopAgentNotDeleted(ctx.agent.id)
    const current = await readAgentConfig(ctx.agent.id).catch(() => null)
    signal?.throwIfAborted()
    ctx.abortSignal?.throwIfAborted()
    if (!desktopBrainToolsAllowed(current)) throw new Error(TURNED_OFF)
}

async function engineDir(signal?: AbortSignal): Promise<string> {
    try { return await resolveDesktopBrainEngineDirectory(await realpath(dataDir()), signal) }
    catch (error) {
        if (error instanceof DesktopBrainProposalError || isAbort(error)) throw error
        throw new DesktopBrainProposalError(404, 'The company brain is not ready.')
    }
}

function isUnconfirmed(heading: string, unconfirmed: Set<string>) {
    return heading.split(' / ').some(part => unconfirmed.has(part))
}

export function desktopBrainTools(ctx: RunContext): ToolSet {
    if (!desktopBrainToolsAllowed(ctx.agent.config)) return {}
    const run = async (signal: AbortSignal | undefined, work: () => Promise<string>): Promise<string> => {
        const release = beginDesktopAgentWork(ctx.agent.id)
        try {
            await requireBrain(ctx, signal)
            const result = await work()
            await requireBrain(ctx, signal)
            return result
        } catch (error) {
            if (isAbort(error)) throw error
            signal?.throwIfAborted()
            ctx.abortSignal?.throwIfAborted()
            if (error instanceof DesktopBrainProposalError) throw new Error(error.message)
            throw error
        } finally { release() }
    }
    const access = (signal?: AbortSignal) => ({ signal, beforeCommit: () => requireBrain(ctx, signal) })
    return {
        brain_search: tool({
            description: 'Search the company brain by keyword. Returns the best passages of each matching page and the pages linked to them. brain_read a page to get all of it. This does not use an embedding service.',
            inputSchema: z.object({
                query: z.string().min(1),
                limit: z.number().int().positive().max(10).default(5),
            }),
            execute: ({ query, limit }, options) => run(options.abortSignal, async () => {
                const engine = await engineDir(options.abortSignal)
                const { hits, related } = await searchDesktopBrain(engine, query, limit ?? 5, options.abortSignal)
                if (hits.length === 0) return 'Nothing in the company brain matches. It may simply not be written down yet.'
                const files = await Promise.all(hits.map(hit => readDesktopBrainPage(engine, hit.slug, options.abortSignal)))
                const blocks = hits.map((hit, index) => {
                    const unconfirmed = new Set(files[index]?.unconfirmed ?? [])
                    const passages = hit.passages.map(passage => `  > ${passage.heading}${isUnconfirmed(passage.heading, unconfirmed) ? ' (unconfirmed)' : ''}: ${excerpt(passage.content)}`)
                    return [`[[${hit.slug}]] ${hit.title} (${hit.type})`, ...passages].join('\n')
                })
                const relatedLine = related.length ? `\n\nLinked pages: ${related.map(item => `[[${item.slug}]] ${item.title}`).join(', ')}` : ''
                return `${blocks.join('\n\n')}${relatedLine}`
            }),
        }),
        brain_read: tool({
            description: 'Read one page of the company brain in full, with its hash (needed to propose a change to it), its sources and the pages that link to it. This does not write.',
            inputSchema: z.object({ slug: z.string().min(1) }),
            execute: ({ slug }, options) => run(options.abortSignal, async () => {
                const engine = await engineDir(options.abortSignal)
                const page = await readDesktopBrainPage(engine, slug, options.abortSignal)
                if (!page) {
                    const slugs = (await listDesktopBrainPages(engine, options.abortSignal)).map(item => item.slug)
                    return `No page "${slug}" in the company brain.${slugs.length ? ` Existing pages: ${slugs.join(', ')}.` : ' The brain is still empty.'}`
                }
                const backlinks = (await listDesktopBrainPages(engine, options.abortSignal))
                    .filter(item => item.slug !== page.slug && item.content.includes(`[[${page.slug}`))
                    .map(item => `[[${item.slug}]]`)
                return formatPage(page, backlinks)
            }),
        }),
        brain_propose: tool({
            description: 'Propose a new page or a change to a page of the company brain. It writes nothing: a person reviews the change and accepts or dismisses it. There is no brain_write on this Mac, including for a fact the user just said. Do not say the page was saved. Give the complete page as content, in markdown, keeping everything still true; it replaces the whole page only after a person accepts it and the page store applies that decision. The person decides from headline (the news in a few words, like a newspaper title: "Pricing is now public") and highlights (one to four facts that move, each with a short unique label, before: what the page says today or null when the fact is new, after: what it will say). To change an existing page, brain_read it first and pass its hash as baseHash; null for a new page. Slugs are lowercase kebab-case; link other pages with [[slug]]. reason says what changed and why, sources where the fact comes from (a URL, a document, "told by the user in chat").',
            inputSchema: brainProposalInputSchema,
            execute: (input, options) => run(options.abortSignal, async () => {
                const engine = await engineDir(options.abortSignal)
                const current = await readDesktopBrainPage(engine, input.slug, options.abortSignal)
                if (current) {
                    if (!input.baseHash) return `The page "${input.slug}" already exists. brain_read it, then propose again with its hash as baseHash and the complete new content.`
                    if (input.baseHash !== current.hash) return `The page "${input.slug}" changed since you read it. brain_read it again and apply your change to the current version.`
                    if (desktopBrainPageHash(input) === current.hash) return 'This is identical to the current page. Nothing sent.'
                }
                const fingerprint = desktopBrainProposalFingerprint({ slug: input.slug, content: input.content })
                if (await findDesktopBrainProposalByFingerprint(engine, fingerprint, options.abortSignal)) return ALREADY
                const proposal = {
                    agentId: ctx.agent.id,
                    agentName: ctx.agent.config.name,
                    sessionId: ctx.sessionId,
                    slug: input.slug,
                    mode: current ? 'edit' as const : 'create' as const,
                    title: input.title.trim(),
                    headline: input.headline.trim(),
                    highlights: input.highlights,
                    type: input.type,
                    content: input.content.trim(),
                    reason: input.reason.trim(),
                    sources: input.sources,
                    baseHash: current ? input.baseHash : null,
                    fingerprint,
                }
                const open = await openDesktopBrainProposalFor(engine, ctx.agent.id, input.slug, options.abortSignal)
                if (open) {
                    await replaceDesktopBrainProposal(engine, open.id, proposal, access(options.abortSignal))
                    return proposalResult('updated', open.id, input.slug, proposal.title, UPDATED)
                }
                const row = await insertDesktopBrainProposal(engine, proposal, access(options.abortSignal))
                return proposalResult('proposed', row.id, input.slug, row.title, PROPOSED)
            }),
        }),
    }
}

function formatPage(page: DesktopBrainPageFile, backlinks: string[]): string {
    const meta = [
        `slug: ${page.slug} | type: ${page.type} | hash: ${page.hash}`,
        `updated ${page.updatedAt || 'at an unknown date'} by ${page.updatedBy}`,
        page.sources.length ? `sources: ${page.sources.join('; ')}` : '',
        page.unconfirmed.length ? `unconfirmed sections: ${page.unconfirmed.join(', ')} (${UNCONFIRMED_NOTE})` : '',
        backlinks.length ? `linked from: ${backlinks.join(', ')}` : '',
    ].filter(Boolean)
    return `# ${page.title}\n${meta.join('\n')}\n\n${page.content}`
}
