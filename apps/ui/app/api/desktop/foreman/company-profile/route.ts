import { z } from 'zod'
import {
    desktopCompanyProfileCancelInputSchema,
    desktopCompanyProfileDecideInputSchema,
    desktopCompanyProfileEnrichInputSchema,
    foremanChatRefSchema,
    type DesktopForemanChatRef,
} from '@rerun/contracts'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopCompanyProfile } from '@/lib/desktop/server/company-profile/binding'
import { DesktopCompanyProfileError } from '@/lib/desktop/server/company-profile/errors'
import { desktopForeman } from '@/lib/desktop/server/foreman/binding'
import { ownedForemanChat } from '@/lib/desktop/server/foreman/chat-store'
import { desktopRoute } from '@/lib/desktop/server/http'
import { readDesktopJson } from '@/lib/desktop/server/request-json'
import type { DesktopRuntime } from '@/lib/desktop/server/runtime'
import { assertDesktopWorkspaceAdmission } from '@/lib/desktop/server/workspace-admission'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const inputSchema = z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('decide'), input: desktopCompanyProfileDecideInputSchema }),
    z.strictObject({ action: z.literal('enrich'), input: desktopCompanyProfileEnrichInputSchema }),
    z.strictObject({ action: z.literal('cancel'), input: desktopCompanyProfileCancelInputSchema }),
])
const STATUS = { conflict: 409, stale: 409, not_found: 404, closed: 503, storage: 503 } as const

/** The company profile of one Foreman conversation of this workspace, and nothing else. */
async function profileFor(runtime: DesktopRuntime, chat: DesktopForemanChatRef) {
    if (chat.workspaceId !== String(runtime.workspaceId)) throw new DesktopHttpError(404, 'Conversation not found.')
    const app = await desktopForeman(runtime)
    await ownedForemanChat(app.db, chat)
    return desktopCompanyProfile(runtime, app)
}
async function answered(work: () => Promise<unknown>): Promise<Response> {
    try {
        return Response.json(await work(), { headers: { 'cache-control': 'no-store' } })
    } catch (error) {
        if (error instanceof DesktopCompanyProfileError) return Response.json({ error: error.message }, { status: STATUS[error.code] })
        throw error
    }
}

/** Reads what is saved. It starts no model call and no website read. */
export async function GET(request: Request) {
    return desktopRoute(request, async runtime => {
        const query = new URL(request.url).searchParams
        const parsed = foremanChatRefSchema.safeParse({ workspaceId: query.get('workspaceId'), chatId: query.get('chatId') })
        if (!parsed.success) throw new DesktopHttpError(400, 'Choose the Foreman conversation for this company profile.')
        const profile = await profileFor(runtime, parsed.data)
        return answered(() => profile.read(parsed.data))
    })
}

export async function POST(request: Request) {
    return desktopRoute(request, async runtime => {
        const parsed = inputSchema.safeParse(await readDesktopJson(request, 16 * 1024))
        if (!parsed.success) throw new DesktopHttpError(400, 'This company profile request was not understood.')
        const { action, input } = parsed.data
        const profile = await profileFor(runtime, action === 'cancel' ? input.chat : input.identity.chat)
        // Stopping is always allowed; starting a model call or a website read needs an open workspace.
        if (action === 'cancel') return answered(() => profile.cancel(input))
        assertDesktopWorkspaceAdmission(runtime)
        return answered(() => action === 'decide' ? profile.decide(input, { signal: request.signal }) : profile.enrich(input, { signal: request.signal }))
    })
}
