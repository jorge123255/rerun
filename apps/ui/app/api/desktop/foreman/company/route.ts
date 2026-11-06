import { z } from 'zod'
import { COMPANY_BRIEF_SECTION_PAGES, brainPageResponseSchema, foremanChatRefSchema, type DesktopCompanyDiscoverySnapshot } from '@rerun/contracts'
import { desktopRoute } from '@/lib/desktop/server/http'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { assertDesktopWorkspaceAdmission } from '@/lib/desktop/server/workspace-admission'
import { readDesktopJson } from '@/lib/desktop/server/request-json'
import { desktopForeman } from '@/lib/desktop/server/foreman/binding'
import { ownedForemanChat } from '@/lib/desktop/server/foreman/chat-store'
import { companyBriefSourceRevision } from '@/lib/desktop/server/company-brief/revision'
import { resolveForemanCompanyBriefModel } from '@/lib/desktop/server/company-brief/model'
import { readCompanyBriefHandoff, readCompanyBrief, synthesizeCompanyBrief, observeCompanyBrief, cancelCompanyBrief, editCompanyBrief, dismissCompanyBrief, retryCompanyBrief, handoffCompanyBrief } from '@/lib/desktop/server/company-brief/client'
import { desktopBrainPagesRequest } from '@/lib/desktop/server/brain-pages'
import type { DesktopRuntime } from '@/lib/desktop/server/runtime'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const base = { chat: foremanChatRefSchema }
const id = { requestId: z.uuid() }
const source = { sourceRevision: z.string().regex(/^[a-f0-9]{64}$/) }
const pages = z.array(z.strictObject({ slug: z.string().min(1).max(128), expectedPageHash: z.string().regex(/^[a-f0-9]{32}$/).nullable() })).max(8)
const schema = z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('synthesize'), ...base, ...id, ...source }),
    z.strictObject({ action: z.literal('retry'), ...base, ...id, ...source, previousRequestId: z.uuid() }),
    z.strictObject({ action: z.literal('edit'), ...base, ...id, expectedDraftRevision: z.number().int().nonnegative(), brief: z.string().max(20_000) }),
    z.strictObject({ action: z.literal('dismiss'), ...base, ...id }),
    z.strictObject({ action: z.literal('cancel'), ...base, ...id }),
    z.strictObject({ action: z.literal('observe'), ...base, active: z.boolean() }),
    z.strictObject({ action: z.literal('handoff'), ...base, ...id, ...source, handoffRequestId: z.uuid(), expectedDraftRevision: z.number().int().nonnegative(), selectedClaimIds: z.array(z.string().min(1).max(80)).min(1).max(40), includeDraft: z.boolean(), expectedPages: pages }),
])

async function own(runtime: DesktopRuntime, chat: z.infer<typeof foremanChatRefSchema>) {
    if (chat.workspaceId !== String(runtime.workspaceId)) throw new DesktopHttpError(404, 'Conversation not found.')
    const app = await desktopForeman(runtime)
    await ownedForemanChat(app.db, chat)
    return app
}
async function pageHashes(runtime: DesktopRuntime, signal: AbortSignal) {
    return Promise.all([...new Set(Object.values(COMPANY_BRIEF_SECTION_PAGES).map(page => page.slug))].map(async slug => {
        try {
            const response = await desktopBrainPagesRequest(runtime, new Request(`${runtime.app.origin}/api/desktop/brain/pages/${encodeURIComponent(slug)}`, { signal }), [slug])
            return { slug, expectedPageHash: brainPageResponseSchema.parse(await response.json()).page.hash }
        }
        catch (error) {
            if (error instanceof DesktopHttpError && error.status === 404) return { slug, expectedPageHash: null }
            throw error
        }
    }))
}
function requireRevision(snapshot: DesktopCompanyDiscoverySnapshot | null, revision: string) {
    if (!snapshot || snapshot.status === 'running' || snapshot.status === 'unknown' || companyBriefSourceRevision(snapshot) !== revision) throw new DesktopHttpError(409, 'Company research changed. Review the current sources first.')
    return snapshot
}
export async function GET(request: Request) {
    return desktopRoute(request, async runtime => {
        const query = new URL(request.url).searchParams
        const parsed = foremanChatRefSchema.safeParse({ workspaceId: query.get('workspaceId'), chatId: query.get('chatId') })
        if (!parsed.success) throw new DesktopHttpError(400, 'Choose a Foreman conversation.')
        const chat = parsed.data
        const app = await own(runtime, chat)
        const discovery = await app.companyDiscovery.read(chat)
        const snapshot = discovery.state === 'present' ? discovery.snapshot : null
        const result = await readCompanyBrief(runtime, chat.workspaceId, chat.chatId, { signal: request.signal })
        return Response.json({ discovery, snapshot, sourceRevision: snapshot ? companyBriefSourceRevision(snapshot) : null, attempt: result.attempt, expectedPages: await pageHashes(runtime, request.signal) }, { headers: { 'cache-control': 'no-store' } })
    })
}
export async function POST(request: Request) {
    return desktopRoute(request, async runtime => {
        const parsed = schema.safeParse(await readDesktopJson(request, 128 * 1024))
        if (!parsed.success) throw new DesktopHttpError(400, 'This company research action was not understood.')
        const input = parsed.data, chat = input.chat
        const app = await own(runtime, chat)
        if (input.action !== 'cancel' && input.action !== 'observe') assertDesktopWorkspaceAdmission(runtime)
        const discovery = await app.companyDiscovery.read(chat)
        const snapshot = discovery.state === 'present' ? discovery.snapshot : null
        const access = { signal: request.signal }
        if (input.action === 'observe') {
            if (!snapshot) return Response.json({ ok: true })
            return Response.json(await observeCompanyBrief(runtime, { ...chat, sourceRevision: companyBriefSourceRevision(snapshot), active: input.active }, access))
        }
        if (input.action === 'cancel') return Response.json(await cancelCompanyBrief(runtime, { ...chat, requestId: input.requestId }, access))
        if (snapshot && (input.action === 'edit' || input.action === 'dismiss')) await observeCompanyBrief(runtime, { ...chat, sourceRevision: companyBriefSourceRevision(snapshot), active: true }, access)
        if (input.action === 'edit') return Response.json(await editCompanyBrief(runtime, { ...chat, requestId: input.requestId, expectedDraftRevision: input.expectedDraftRevision, brief: input.brief }, access))
        if (input.action === 'dismiss') return Response.json(await dismissCompanyBrief(runtime, { ...chat, requestId: input.requestId }, access))
        if (input.action === 'handoff') {
            const saved = await readCompanyBriefHandoff(runtime, { ...chat, requestId: input.requestId, handoffRequestId: input.handoffRequestId, sourceRevision: input.sourceRevision, expectedDraftRevision: input.expectedDraftRevision, selectedClaimIds: input.selectedClaimIds, includeDraft: input.includeDraft, expectedPages: input.expectedPages }, access)
            if (saved.receipt) return Response.json(saved.receipt)
        }
        const settled = requireRevision(snapshot, input.sourceRevision)
        await observeCompanyBrief(runtime, { ...chat, sourceRevision: input.sourceRevision, active: true }, access)
        if (input.action === 'handoff') {
            const current = await pageHashes(runtime, request.signal)
            for (const expected of input.expectedPages) {
                if (!current.some(page => page.slug === expected.slug && page.expectedPageHash === expected.expectedPageHash)) throw new DesktopHttpError(409, 'A Company Brain page changed. Review the proposal again.')
            }
            const body = { ...chat, requestId: input.requestId, handoffRequestId: input.handoffRequestId, sourceRevision: input.sourceRevision, expectedDraftRevision: input.expectedDraftRevision, selectedClaimIds: input.selectedClaimIds, includeDraft: input.includeDraft, expectedPages: input.expectedPages }
            return Response.json(await handoffCompanyBrief(runtime, body, access))
        }
        const model = await resolveForemanCompanyBriefModel(runtime, chat)
        const body = { ...chat, requestId: input.requestId, sourceRevision: input.sourceRevision, snapshot: settled, model }
        return Response.json(input.action === 'retry' ? await retryCompanyBrief(runtime, { ...body, previousRequestId: input.previousRequestId }, access) : await synthesizeCompanyBrief(runtime, body, access))
    })
}
