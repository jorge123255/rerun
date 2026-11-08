import { z } from 'zod'

/** Original model tool `post_status` (`whatsapp_pro_post_status`): Linkup category `content`, action `create`. */
export const WHATSAPP_STATUS_TOOL_NAME = 'whatsapp_pro_post_status'
export const WHATSAPP_STATUS_OPERATION = { category: 'content', action: 'create', name: 'post_status' } as const

export const WHATSAPP_STATUS_DESCRIPTION =
    "Post a WhatsApp Status from the user's number: a story that stays 24 hours, seen by the contacts they recently chatted with, or only by phone_numbers. Nobody gets a message. Give a text, or an image or video by public URL with the text as its caption. Answers the Status id, how many people can see it and when it expires."

export const whatsappStatusFieldOrder = ['message', 'file', 'phone_numbers', 'background_color', 'font'] as const

export const whatsappStatusFieldCopy = {
    message: 'The text of the Status, or the caption of the image or video',
    file: 'Public URL of one image or video',
    phone_numbers: 'Who sees it, in international format. Leave out for the 500 most recent one-to-one chats',
    background_color: 'Background of a text Status, as hex, e.g. #25D366',
    font: 'Font of a text Status, 0 to 5',
} as const

const publicFileUrl = z.string().max(2048).refine(value => {
    try {
        const url = new URL(value)
        return (url.protocol === 'https:' || url.protocol === 'http:') && url.username === '' && url.password === ''
    } catch {
        return false
    }
}, 'The Status file must be a public http(s) URL.')

export const whatsappStatusInputSchema = z.object({
    message: z.string().min(1).max(10_000).optional(),
    file: publicFileUrl.optional(),
    phone_numbers: z.array(z.string().min(1).max(32)).max(500).optional(),
    background_color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
    font: z.number().int().min(0).max(5).optional(),
}).strict()

export type WhatsappStatusInput = z.infer<typeof whatsappStatusInputSchema>

export const whatsappStatusParamsSchema = whatsappStatusInputSchema.refine(value => value.message !== undefined || value.file !== undefined, 'Give a text, or an image or video by public URL.')

export type WhatsappStatusParams = z.infer<typeof whatsappStatusParamsSchema>

export const whatsappStatusDisabledReasonSchema = z.enum(['unbound', 'capability-off', 'credential-missing', 'revoked'])
export type WhatsappStatusDisabledReason = z.infer<typeof whatsappStatusDisabledReasonSchema>

export const whatsappStatusBindingSchema = z.discriminatedUnion('phase', [
    z.object({ phase: z.literal('disabled'), reason: whatsappStatusDisabledReasonSchema }).strict(),
    z.object({
        phase: z.literal('ready'),
        accountId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
        connectionId: z.string().uuid(),
    }).strict(),
])
export type WhatsappStatusBinding = z.infer<typeof whatsappStatusBindingSchema>

export const whatsappStatusReceiptSchema = z.object({
    statusId: z.string().regex(/^[A-Za-z0-9_.:@-]{1,128}$/),
    audienceCount: z.number().int().min(0).max(500),
    expiresAt: z.string().datetime(),
}).strict()
export type WhatsappStatusReceipt = z.infer<typeof whatsappStatusReceiptSchema>

export const whatsappStatusResultSchema = z.discriminatedUnion('outcome', [
    z.object({ outcome: z.literal('posted'), posted: z.literal(true), receipt: whatsappStatusReceiptSchema }).strict(),
    z.object({ outcome: z.literal('refused'), posted: z.literal(false), message: z.string().min(1).max(400) }).strict(),
    z.object({ outcome: z.literal('cancelled'), posted: z.literal(false), message: z.string().min(1).max(400) }).strict(),
    z.object({ outcome: z.literal('uncertain'), posted: z.literal(false), message: z.string().min(1).max(400) }).strict(),
])
export type WhatsappStatusResult = z.infer<typeof whatsappStatusResultSchema>

export const whatsappStatusSetupCopy: Record<WhatsappStatusDisabledReason | 'ready', string> = {
    unbound: 'WhatsApp Status is not set up on this Mac. Nothing is posted.',
    'capability-off': 'WhatsApp Status stays off until this coworker is allowed to use the connected WhatsApp account. Nothing is posted.',
    'credential-missing': 'No Linkup credential and no selected WhatsApp account are bound. Nothing is posted.',
    revoked: 'The selected WhatsApp account was revoked. Nothing is posted.',
    ready: 'A selected WhatsApp account is bound. Posting still requires the desktop dispatch port and does not run from this screen.',
}

export function declaredWhatsappStatusParams(input: WhatsappStatusInput): WhatsappStatusParams {
    const params: WhatsappStatusInput = {}
    for (const key of whatsappStatusFieldOrder) {
        const value = input[key]
        if (value === undefined) continue
        if (typeof value === 'string' && value.trim() === '') continue
        if (Array.isArray(value) && value.length === 0) continue
        Object.assign(params, { [key]: value })
    }
    return whatsappStatusParamsSchema.parse(params)
}
