// What a paired phone and the Mac app say to each other on the Mac's phone listener
// (`/api/mac-pairing/v1`, served by apps/desktop/src/main/mac-phone-pairing). The Mac writes these
// shapes and the phone app checks them on the way in, so a field is added here before either side
// reads it. Nothing here carries a provider credential, a saved secret or the engine's key.
import { z } from 'zod'

export const MAC_PHONE_PAIRING_API_PREFIX = '/api/mac-pairing/v1'
export const MAC_PHONE_PAIRING_SERVICE = 'rerun-mac-phone-pairing'

const hash = z.string().regex(/^[0-9a-f]{64}$/)
const secret = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
const savedId = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/)

// The offer the Mac shows, as a QR code or as text, for two minutes. `secret` redeems it once.
// `certificateFingerprint` is the SHA-256 of the certificate the listener serves on the local
// network: the phone talks to no other.
export const macPairingOfferSchema = z.object({
    version: z.literal(1),
    kind: z.literal(MAC_PHONE_PAIRING_SERVICE),
    offerId: z.string().uuid(),
    workspaceId: z.number().int().positive(),
    macId: z.string().min(1).max(200),
    fingerprint: hash,
    secret,
    expiresAt: z.string(),
    origin: z.string().url(),
    ttlMs: z.number().int().positive().optional(),
    certificateFingerprint: hash.optional(),
})
export type MacPairingOffer = z.infer<typeof macPairingOfferSchema>

// POST /pair/redeem. The phone is then listed on the Mac, waiting for the person to approve it.
export const macPairingRedeemSchema = z.object({
    offerId: z.string(),
    macId: z.string(),
    fingerprint: z.string(),
    secret: z.string(),
    deviceName: z.string().max(80).optional(),
})
export const macPairingPendingSchema = z.object({
    status: z.literal('pending'),
    deviceId: z.string().uuid(),
    requestToken: secret,
    workspaceId: z.number().int().positive(),
})

// POST /pair/status. `credential` is handed over once, after the approval, and is the token the
// phone sends from then on. The Mac keeps only its hash.
export const macPairingStatusSchema = z.discriminatedUnion('status', [
    z.object({ status: z.literal('pending'), deviceId: z.string().uuid(), workspaceId: z.number().int().positive() }),
    z.object({ status: z.literal('revoked') }),
    z.object({
        status: z.literal('approved'),
        deviceId: z.string().uuid(),
        workspaceId: z.number().int().positive(),
        macId: z.string(),
        fingerprint: hash,
        credential: secret,
    }),
])
export type MacPairingStatus = z.infer<typeof macPairingStatusSchema>

const sendPermission = z.object({ sendMessages: z.boolean() })

// GET /workspaces/:workspace/coworkers
export const macPhoneCoworkerSchema = z.object({ id: savedId, name: z.string(), status: z.enum(['enabled', 'disabled']) })
export const macPhoneCoworkersSchema = z.object({ coworkers: z.array(macPhoneCoworkerSchema) })
export type MacPhoneCoworker = z.infer<typeof macPhoneCoworkerSchema>

// GET /workspaces/:workspace/coworkers/:coworker/chats
export const macPhoneChatSchema = z.object({
    id: savedId,
    agentId: savedId,
    title: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    kind: z.enum(['general', 'thread']),
})
export const macPhoneChatsSchema = z.object({ acceptsMessages: z.boolean(), chats: z.array(macPhoneChatSchema), permissions: sendPermission.optional() })
export type MacPhoneChat = z.infer<typeof macPhoneChatSchema>

export const macPhoneMessageSchema = z.object({
    id: z.string(),
    role: z.enum(['user', 'assistant']),
    createdAt: z.string().optional(),
    content: z.object({ type: z.literal('text'), text: z.string() }),
})
export type MacPhoneMessage = z.infer<typeof macPhoneMessageSchema>

// A question or an approval the chat waits on, in words only. Absent from a Mac older than it.
export const macPhonePendingSchema = z.object({
    question: z.object({
        toolCallId: z.string(),
        questions: z.array(z.object({ question: z.string(), header: z.string().optional(), options: z.array(z.string()), multiple: z.boolean() })),
    }).nullable(),
    approval: z.object({
        toolCallId: z.string(),
        approvals: z.array(z.object({ action: z.string(), detail: z.string().optional() })),
    }).nullable(),
})
export type MacPhonePending = z.infer<typeof macPhonePendingSchema>

// GET /workspaces/:workspace/coworkers/:coworker/chats/:chat
export const macPhoneChatReadSchema = z.object({
    chat: macPhoneChatSchema.extend({ acceptsMessages: z.boolean() }),
    messages: z.array(macPhoneMessageSchema),
    pending: macPhonePendingSchema.optional(),
    permissions: sendPermission.optional(),
})
export type MacPhoneChatRead = z.infer<typeof macPhoneChatReadSchema>

// POST .../chats (a new conversation) and POST .../chats/:chat (one more message). `requestId` is
// chosen by the phone: sending it again never starts a second turn.
export const macPhoneSendSchema = z.object({ requestId: z.string().uuid(), text: z.string().min(1).max(20_000) }).strict()
// POST .../chats/:chat with the answer to the question the chat waits on, instead of a message.
// `toolCallId` is the card the phone was shown; `answers` holds the choices for each of its
// questions, in order, and is left out to dismiss the question. It needs the send permission.
export const macPhoneAnswerSchema = z.object({
    requestId: z.string().uuid(),
    answer: z.object({ toolCallId: z.string().min(1).max(256), answers: z.array(z.array(z.string().max(4000)).max(100)).min(1).max(32).optional() }).strict(),
}).strict()
export const macPhoneSendReceiptSchema = z.object({ requestId: z.string().uuid(), chatId: savedId.optional() })

// GET .../chats/:chat/turns/:requestId, and the lines of .../turns/:requestId/stream.
export const macPhoneTurnSchema = z.object({ status: z.enum(['running', 'done', 'error', 'cancelled']) })
export const macPhoneReplyFrameSchema = z.union([z.object({ reset: z.literal(true) }), z.object({ delta: z.string() })])
export type MacPhoneReplyFrame = z.infer<typeof macPhoneReplyFrameSchema>

// Every refusal is `{ error: code }`. A phone that is not approved, or was removed, gets `unauthorized`.
export const macPhoneErrorSchema = z.object({ error: z.string() })
