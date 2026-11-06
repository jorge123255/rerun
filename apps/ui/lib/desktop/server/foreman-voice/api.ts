import 'server-only'
import {
    foremanVoiceRequestSchema, foremanVoiceTargetSchema,
} from '../../../../../../packages/contracts/src/desktop-foreman-voice'
import { DesktopHttpError } from '../auth'
import { readDesktopRuntime } from '../runtime'
import { assertDesktopWorkspaceAdmission } from '../workspace-admission'
import { readDesktopJson } from '../request-json'
import type { createForemanVoiceRuntime } from './runtime'

/** Mount only inside desktopRoute, after its existing local session/origin checks. */
export function foremanVoiceHandlers(voice: ReturnType<typeof createForemanVoiceRuntime>) {
    return {
        async post(request: Request) {
            try {
                const parsed = foremanVoiceRequestSchema.safeParse(await readDesktopJson(request, 3 * 1024 * 1024))
                if (!parsed.success) throw new DesktopHttpError(400, 'This Foreman recording request was not understood.')
                if (parsed.data.action === 'send' || parsed.data.action === 'transcribe') assertDesktopWorkspaceAdmission(await readDesktopRuntime())
                return Response.json(await voice.handle(parsed.data, request.signal), { headers: { 'cache-control': 'no-store' } })
            } catch (error) {
                return Response.json({ error: error instanceof DesktopHttpError ? error.message : 'Foreman voice acknowledgement unavailable. Read the same attempt before retrying.' }, { status: error instanceof DesktopHttpError ? error.status : 503 })
            }
        },
        async audio(request: Request) {
            try {
                const q = new URL(request.url).searchParams
                const target = foremanVoiceTargetSchema.parse({ chat: { workspaceId: q.get('workspaceId'), chatId: q.get('chatId') }, model: { connectionId: q.get('connectionId'), model: q.get('model') } })
                const id = q.get('attemptId') ?? ''
                foremanVoiceRequestSchema.parse({ action: 'read', target, attemptId: id })
                const r = await voice.audio(target, id, request.signal)
                return new Response(Uint8Array.from(r.bytes).buffer, { headers: { 'content-type': r.mimeType, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-disposition': 'inline' } })
            } catch { return Response.json({ error: 'This Foreman recording is unavailable.' }, { status: 409 }) }
        },
    }
}
