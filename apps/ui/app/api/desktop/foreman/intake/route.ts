import { z } from 'zod'
import { desktopForemanIntakeCompleteInputSchema, desktopForemanIntakeSaveInputSchema, foremanChatRefSchema, industryHint, type DesktopForemanChatRef } from '@rerun/contracts'
import { desktopRoute } from '@/lib/desktop/server/http'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopForeman } from '@/lib/desktop/server/foreman/binding'
import { ownedForemanChat } from '@/lib/desktop/server/foreman/chat-store'
import { createDesktopForemanIntakeBinding } from '@/lib/desktop/server/foreman/intake'
import { desktopCompanyProfile } from '@/lib/desktop/server/company-profile/binding'
import { assertDesktopCompanyProfileIntakeHints } from '@/lib/desktop/server/company-profile/intake-hints'
import type { DesktopRuntime } from '@/lib/desktop/server/runtime'
import { DesktopForemanIntakeConflictError, DesktopForemanIntakeRefusal } from '@/lib/desktop/server/foreman-intake/store'
import { readDesktopJson } from '@/lib/desktop/server/request-json'
import { assertDesktopWorkspaceAdmission } from '@/lib/desktop/server/workspace-admission'

export const runtime = 'nodejs'
const inputSchema = z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('save'), input: desktopForemanIntakeSaveInputSchema }),
    z.strictObject({ action: z.literal('complete'), input: desktopForemanIntakeCompleteInputSchema }),
    z.strictObject({ action: z.literal('lookup'), chat: foremanChatRefSchema, requestId: z.uuid() }),
    z.strictObject({ action: z.literal('decide-industry'), chat: foremanChatRefSchema, hint: z.string().trim().min(1).max(500) }),
    z.strictObject({ action: z.literal('analyze-site'), chat: foremanChatRefSchema, hint: z.string().trim().min(1).max(500) }),
])

/** The intake with its optional helpers for this chat: industry suggestion, website read, and the first name saved on this Mac. */
async function intakeFor(runtime: DesktopRuntime, app: Awaited<ReturnType<typeof desktopForeman>>, chat: DesktopForemanChatRef) {
    const profile = desktopCompanyProfile(runtime, app)
    const knownFirstName = await profile.resolveKnownFirstName(chat).catch(() => null)
    return { profile, service: createDesktopForemanIntakeBinding(runtime, app, { chat, profile, knownFirstName }) }
}

export async function GET(request: Request) {
    return desktopRoute(request, async runtime => {
        const query = new URL(request.url).searchParams
        const parsed = foremanChatRefSchema.safeParse({ workspaceId: query.get('workspaceId'), chatId: query.get('chatId') })
        if (!parsed.success) throw new DesktopHttpError(400, 'Choose the Foreman conversation for these company details.')
        if (parsed.data.workspaceId !== String(runtime.workspaceId)) throw new DesktopHttpError(404, 'Conversation not found.')
        const app = await desktopForeman(runtime)
        await ownedForemanChat(app.db, parsed.data)
        try {
            return Response.json(await (await intakeFor(runtime, app, parsed.data)).service.read(parsed.data), { headers: { 'cache-control': 'no-store' } })
        } catch (error) {
            if (error instanceof DesktopForemanIntakeRefusal) throw new DesktopHttpError(error.status, error.message)
            throw error
        }
    })
}

export async function POST(request: Request) {
    return desktopRoute(request, async runtime => {
        const parsed = inputSchema.safeParse(await readDesktopJson(request, 32 * 1024))
        if (!parsed.success) throw new DesktopHttpError(400, 'These company details were not understood.')
        const input = parsed.data, chat = 'chat' in input ? input.chat : input.input.chat
        if (chat.workspaceId !== String(runtime.workspaceId)) throw new DesktopHttpError(404, 'Conversation not found.')
        const app = await desktopForeman(runtime)
        await ownedForemanChat(app.db, chat)
        const { profile, service } = await intakeFor(runtime, app, chat)
        try {
            if (input.action === 'lookup') return Response.json({ completion: await service.lookupCompletion(chat, input.requestId) })
            if (input.action === 'save') {
                // An automatic value is accepted only when it is the current suggestion for these exact
                // saved answers, or the first name saved on this Mac. Anything else is refused.
                try {
                    await assertDesktopCompanyProfileIntakeHints(profile, input.input)
                } catch (error) {
                    if (error instanceof DesktopHttpError) throw error
                    // A hint that cannot be checked is not accepted on trust.
                    throw new DesktopHttpError(400, 'Use your own company answers; this automatic hint could not be confirmed.')
                }
                return Response.json(await service.save(input.input))
            }
            if (input.action === 'decide-industry' || input.action === 'analyze-site') {
                assertDesktopWorkspaceAdmission(runtime)
                // The suggestion is made from the saved answer. While the typed text is still being
                // saved the two differ, and the caller asks again.
                const saved = (await service.read(chat)).session
                const typed = saved.draft.websiteSkipped ? null : saved.draft.companyUrl.trim() || null
                const current = input.action === 'decide-industry' ? industryHint(saved.draft) : typed
                if (current !== input.hint) {
                    // A social or marketplace address says nothing about the industry: no suggestion, and no retry.
                    if (input.action === 'decide-industry' && typed === input.hint) return Response.json({ industry: null })
                    return Response.json({ error: 'These company details are still being saved.', pending: true }, { status: 409 })
                }
                if (input.action === 'decide-industry') return Response.json({ industry: await service.decideIndustry(input.hint) })
                // The website read is a convenience: when it cannot finish, the intake carries on and
                // says why, instead of failing the request.
                try {
                    const read = await profile.analyzeSite(chat)
                    const outcome = read.attempt?.outcome
                    return Response.json({
                        state: outcome?.status === 'succeeded' ? 'ready' : outcome?.status === 'unavailable' ? 'unavailable' : 'failed',
                        ...(outcome && outcome.status !== 'succeeded' && 'message' in outcome && { reason: outcome.message.slice(0, 200) }),
                    })
                } catch (error) {
                    if (error instanceof DesktopHttpError) throw error
                    return Response.json({ state: 'failed', reason: (error instanceof Error && error.message ? `${error.name}: ${error.message}` : 'The website could not be read.').slice(0, 200) })
                }
            }
            assertDesktopWorkspaceAdmission(runtime)
            return Response.json(await service.complete(input.input))
        } catch (error) {
            if (error instanceof DesktopForemanIntakeConflictError) return Response.json({ error: error.message, view: error.view }, { status: 409 })
            if (error instanceof DesktopForemanIntakeRefusal) return Response.json({ error: error.message }, { status: error.status })
            throw error
        }
    })
}
