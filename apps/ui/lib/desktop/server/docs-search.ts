import 'server-only'
import { z } from 'zod'
import { DESKTOP_FOREMAN_DOCS_LIMITS, RERUN_PUBLIC_DOCS_CORPUS, desktopForemanDocsQuerySchema } from '@rerun/contracts'
import { authenticateDesktopEngineRequest } from './auth'
import { getDesktopRemoteMcpService } from './mcp-binding'
import { boundedText } from './mcp/remote'
import { readDesktopForemanDocsCorpus } from './foreman-docs/fetch'
import { desktopForemanDocsSectionTitle, parseDesktopForemanDocs, rankDesktopForemanDocs, type DesktopForemanDocsSection } from './foreman-docs/search'

const identity = z.string().min(1).max(200)
const inputSchema = z.strictObject({ identity: z.strictObject({ agentId: identity, sessionId: identity, runId: identity, toolCallId: identity }), query: desktopForemanDocsQuerySchema.shape.query })
const FRESH_MS = 60 * 60_000
// One copy of the public export per app launch, refreshed hourly. Nothing about a coworker is kept with it.
let cached: { sections: DesktopForemanDocsSection[]; at: number } | null = null

export async function readDesktopDocsSections(signal: AbortSignal, assertLive: () => Promise<void>, now = Date.now(), read = readDesktopForemanDocsCorpus) {
    if (cached && now - cached.at < FRESH_MS) return { sections: cached.sections, stale: false }
    try {
        const sections = parseDesktopForemanDocs((await read(RERUN_PUBLIC_DOCS_CORPUS, signal, assertLive)).body)
        if (!sections.length) throw new Error('The documentation export is empty.')
        cached = { sections, at: now }
        return { sections, stale: false }
    } catch (error) {
        signal.throwIfAborted()
        if (cached) return { sections: cached.sections, stale: true }
        throw error
    }
}
export function resetDesktopDocsCache() { cached = null }

export function desktopDocsAnswer(sections: DesktopForemanDocsSection[], query: string, stale: boolean) {
    const hits = rankDesktopForemanDocs(sections, query)
    const notes: string[] = []
    if (!hits.length) notes.push('Nothing in the documentation matched those words. Try another wording, and never invent an answer.')
    if (stale) notes.push('The documentation could not be refreshed. These passages come from the copy read earlier.')
    return {
        status: hits.length ? 'ok' : 'empty', documentation: RERUN_PUBLIC_DOCS_CORPUS.documentation,
        passages: hits.map(section => ({ title: desktopForemanDocsSectionTitle(section).slice(0, 600), url: section.url, text: section.body.slice(0, DESKTOP_FOREMAN_DOCS_LIMITS.passageChars) })),
        ...(notes.length ? { note: notes.join(' ') } : {}),
    }
}

/** A coworker's search of the public Rerun documentation. The run must hold the Rerun documentation permission. */
export async function handleDesktopDocsSearch(request: Request) {
    const headers = { 'Cache-Control': 'no-store' }
    try {
        const runtime = await authenticateDesktopEngineRequest(request)
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(24_000)])
        const body = inputSchema.parse(JSON.parse(await boundedText(new Response(request.body), signal, 16_384)))
        const owner = await getDesktopRemoteMcpService(runtime)
        const run = { engineAgentId: body.identity.agentId, sessionId: body.identity.sessionId, runId: body.identity.runId }
        await owner.authorizeRun(run, signal, 'docs')
        const { sections, stale } = await readDesktopDocsSections(signal, async () => { await owner.authorizeRun(run, signal, 'docs') })
        await owner.authorizeRun(run, signal, 'docs')
        return Response.json(desktopDocsAnswer(sections, body.query, stale), { headers })
    } catch {
        return Response.json({ status: 'unavailable', documentation: RERUN_PUBLIC_DOCS_CORPUS.documentation, passages: [], note: `The documentation could not be read. Point the user at ${RERUN_PUBLIC_DOCS_CORPUS.documentation} rather than answering from memory.` }, { headers })
    }
}
