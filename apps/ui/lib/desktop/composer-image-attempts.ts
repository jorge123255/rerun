import { z } from 'zod'
import { DESKTOP_IMAGE_ATTACHMENT_MAX_BYTES, desktopImageKindForName } from './composer-image'
import { desktopUploadAttemptsSchema } from './composer-upload-attempts'

export const desktopImageUploadScopeSchema = z.object({ tabUid: z.string().min(1).max(128) }).strict()
export const desktopImageUploadAttemptSchema = z.object({
    id: z.string().uuid(),
    name: z.string().min(1).max(255).refine(name => new TextEncoder().encode(name).length <= 255 && !/[\\/\p{Cc}]/u.test(name) && !name.startsWith('.') && !!desktopImageKindForName(name)),
    size: z.number().int().min(0).max(DESKTOP_IMAGE_ATTACHMENT_MAX_BYTES),
}).strict()
export const desktopImageUploadReserveSchema = desktopImageUploadScopeSchema.extend(desktopImageUploadAttemptSchema.shape).strict()
export const desktopImageUploadDismissSchema = desktopImageUploadScopeSchema.extend({ id: z.string().uuid() }).strict()
export const desktopImageUploadAttemptsSchema = z.object({ attempts: z.array(desktopImageUploadAttemptSchema).max(10) })
export type DesktopImageUploadAttempt = z.infer<typeof desktopImageUploadAttemptSchema>

const endpoint = (agentId: string) => `/api/desktop/agents/${encodeURIComponent(agentId)}/upload-attempts`
async function request(agentId: string, init: RequestInit, query = '') {
    const response = await fetch(endpoint(agentId) + query, { cache: 'no-store', ...init })
    const body = await response.json()
    if (!response.ok) throw new Error('Could not save the upload status. Try again before importing images.')
    return body
}
export async function readDesktopImageUploadAttempts(agentId: string, tabUid: string, signal?: AbortSignal) {
    return desktopUploadAttemptsSchema.parse(await request(agentId, { signal }, `?${new URLSearchParams({ tabUid })}`)).attempts
        .filter(item => !!desktopImageKindForName(item.name)).map(item => desktopImageUploadAttemptSchema.parse(item))
}
export async function reserveDesktopImageUploadAttempt(agentId: string, tabUid: string, attempt: DesktopImageUploadAttempt, signal?: AbortSignal) {
    const result = await request(agentId, { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tabUid, ...attempt }) })
    return z.object({ created: z.boolean(), attempt: desktopImageUploadAttemptSchema }).parse(result)
}
export async function dismissDesktopImageUploadAttempt(agentId: string, tabUid: string, id: string, signal?: AbortSignal) {
    await request(agentId, { method: 'DELETE', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tabUid, id }) })
}
