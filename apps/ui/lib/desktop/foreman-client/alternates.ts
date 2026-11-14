import { foremanAlternateListEntrySchema, foremanAlternateViewSchema, type DesktopForemanChatRef } from '@rerun/contracts'
import { z } from 'zod'

const path = '/api/desktop/foreman/alternates'
const listSchema = z.strictObject({ items: z.array(foremanAlternateListEntrySchema) })
const preparationSchema = z.strictObject({ requestId: z.uuid(), status: z.enum(['prepared', 'uncertain']) })
const commandSchema = z.strictObject({ requestId: z.uuid(), status: foremanAlternateViewSchema.shape.status })
export type ForemanAlternateListEntry = z.infer<typeof foremanAlternateListEntrySchema>
export type ForemanAlternateView = z.infer<typeof foremanAlternateViewSchema>

async function request(route: string, signal: AbortSignal, body?: unknown) {
    const response = await fetch(route, {
        cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(28_000)]),
        ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    })
    const value: unknown = await response.json()
    if (!response.ok) {
        const error = z.object({ error: z.string().max(512) }).safeParse(value)
        throw new Error(error.success ? error.data.error : 'Could not load the Chief of Staff retry.')
    }
    return value
}

function exactRetry<T extends { requestId: string }>(requestId: string, result: T) {
    if (result.requestId !== requestId) throw new Error('The Chief of Staff retry changed.')
    return result
}

export function createForemanAlternateClient(chat: DesktopForemanChatRef) {
    const query = (requestId?: string) => path + '?' + new URLSearchParams({ ...chat, ...(requestId && { requestId }) })
    return {
        async list(signal: AbortSignal) { return listSchema.parse(await request(query(), signal)).items },
        async read(requestId: string, signal: AbortSignal) {
            return exactRetry(requestId, foremanAlternateViewSchema.parse(await request(query(requestId), signal)))
        },
        async review(messageId: string, snapshot: string, signal: AbortSignal) {
            z.strictObject({ ok: z.literal(true) }).parse(await request(path + '/review', signal, { action: 'review', chat, messageId, snapshot }))
        },
        async prepare(requestId: string, messageId: string, snapshot: string, signal: AbortSignal) {
            return exactRetry(requestId, preparationSchema.parse(await request(path + '/review', signal, { action: 'prepare', chat, requestId, messageId, snapshot })))
        },
        async recover(requestId: string, signal: AbortSignal) {
            return exactRetry(requestId, preparationSchema.parse(await request(path + '/review', signal, { action: 'recover', chat, requestId })))
        },
        async run(action: 'start' | 'stop', requestId: string, signal: AbortSignal) {
            return exactRetry(requestId, commandSchema.parse(await request(path + '/run', signal, { action, chat, requestId })))
        },
    }
}
