import { z } from 'zod'
import { DESKTOP_ATTACHMENT_MAX_BYTES } from '@rerun/contracts'
import { DESKTOP_IMAGE_MAX_BYTES } from './server/image-bytes'

export const desktopUploadScopeSchema = z.object({ tabUid: z.string().min(1).max(128) }).strict()
export const desktopUploadAttemptSchema = z.object({
    id: z.string().uuid(), name: z.string().min(1).max(255).refine(name => new TextEncoder().encode(name).length <= 255 && !/[\\/\p{Cc}]/u.test(name) && !name.startsWith('.') && /\.(txt|md|png|jpe?g|webp|gif|avif|ico|bmp|svg)$/i.test(name)),
    size: z.number().int().min(0).max(DESKTOP_IMAGE_MAX_BYTES),
}).refine(item => !/\.(txt|md)$/i.test(item.name) || item.size <= DESKTOP_ATTACHMENT_MAX_BYTES)
export const desktopUploadReserveSchema = desktopUploadScopeSchema.extend(desktopUploadAttemptSchema.shape).strict().refine(item => !/\.(txt|md)$/i.test(item.name) || item.size <= DESKTOP_ATTACHMENT_MAX_BYTES)
export const desktopUploadDismissSchema = desktopUploadScopeSchema.extend({ id: z.string().uuid() }).strict()
export const desktopUploadAttemptsSchema = z.object({ attempts: z.array(desktopUploadAttemptSchema).max(14) })
export type DesktopUploadAttempt = z.infer<typeof desktopUploadAttemptSchema>

const endpoint = (agentId: string) => `/api/desktop/agents/${encodeURIComponent(agentId)}/upload-attempts`
async function request(agentId: string, init: RequestInit, query = '') {
    const response = await fetch(endpoint(agentId) + query, { cache: 'no-store', ...init })
    const body = await response.json()
    if (!response.ok) throw new Error('Could not save the upload status. Try again before importing files.')
    return body
}
export async function readDesktopUploadAttempts(agentId: string, tabUid: string, signal?: AbortSignal) {
    return desktopUploadAttemptsSchema.parse(await request(agentId, { signal }, `?${new URLSearchParams({ tabUid })}`)).attempts.filter(item => /\.(txt|md)$/i.test(item.name))
}
export async function reserveDesktopUploadAttempt(agentId: string, tabUid: string, attempt: DesktopUploadAttempt, signal?: AbortSignal) {
    const result = await request(agentId, { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tabUid, ...attempt }) })
    return z.object({ created: z.boolean(), attempt: desktopUploadAttemptSchema }).parse(result)
}
export async function dismissDesktopUploadAttempt(agentId: string, tabUid: string, id: string, signal?: AbortSignal) {
    await request(agentId, { method: 'DELETE', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tabUid, id }) })
}
