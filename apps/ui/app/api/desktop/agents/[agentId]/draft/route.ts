import { desktopComposerDraftClearSchema, desktopComposerDraftScopeSchema, desktopComposerDraftWriteSchema } from '@/lib/desktop/composer-draft'
import { authenticateDesktopEngineRequest, authenticateDesktopRequest, DesktopHttpError } from '@/lib/desktop/server/auth'
import { clearDesktopComposerDraft, DesktopDraftConflict, DraftAttachmentRejected, readDesktopComposerDraft, writeDesktopComposerDraft } from '@/lib/desktop/server/composer-draft'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { desktopRoute } from '@/lib/desktop/server/http'

export const dynamic = 'force-dynamic'
type Params = { params: Promise<{ agentId: string }> }
const headers = { 'cache-control': 'no-store' }

export async function GET(request: Request, { params }: Params) {
    return desktopRoute(request, async runtime => {
        const parsed = desktopComposerDraftScopeSchema.safeParse(Object.fromEntries(new URL(request.url).searchParams))
        if (!parsed.success) throw new DesktopHttpError(400, 'Choose a conversation tab.')
        return Response.json(await readDesktopComposerDraft(await openDesktopDatabase(runtime.dataRoot), (await params).agentId, parsed.data.tabUid), { headers })
    })
}

async function authenticateDraftSave(request: Request) {
    if (!request.headers.has('authorization')) return authenticateDesktopRequest(request)
    // Only the native process forwards pending saves during its draft handshake.
    const runtime = await authenticateDesktopEngineRequest(request)
    if (request.headers.get('x-rerun-launch-nonce') !== runtime.launchNonce) throw new DesktopHttpError(409, 'The workspace launch changed.')
    return runtime
}

export async function PUT(request: Request, { params }: Params) {
    return desktopRoute(request, async runtime => {
        const parsed = desktopComposerDraftWriteSchema.safeParse(await request.json().catch(() => null))
        if (!parsed.success) throw new DesktopHttpError(400, 'Choose a valid draft and its saved version.')
        try { return Response.json(await writeDesktopComposerDraft(runtime, (await params).agentId, parsed.data), { headers }) }
        catch (error) {
            if (error instanceof DraftAttachmentRejected) return Response.json({ error: error.message, code: error.code }, { status: error.status, headers })
            if (error instanceof DesktopDraftConflict) return Response.json({ error: error.message, draft: error.draft }, { status: 409, headers })
            throw error
        }
    }, authenticateDraftSave)
}

export async function DELETE(request: Request, { params }: Params) {
    return desktopRoute(request, async runtime => {
        const parsed = desktopComposerDraftClearSchema.safeParse(await request.json().catch(() => null))
        if (!parsed.success) throw new DesktopHttpError(400, 'Choose the exact draft to clear.')
        try { return Response.json(await clearDesktopComposerDraft(runtime, (await params).agentId, parsed.data), { headers }) }
        catch (error) {
            if (error instanceof DesktopDraftConflict) return Response.json({ error: error.message, draft: error.draft }, { status: 409, headers })
            throw error
        }
    })
}
