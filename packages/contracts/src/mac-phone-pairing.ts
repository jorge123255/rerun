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

// What the person allowed this phone on the Mac, each its own switch there. `approveRequests` is
// absent from a Mac older than it.
const sendPermission = z.object({ sendMessages: z.boolean(), approveRequests: z.boolean().optional() })

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
    // A request only the Mac settles: a held app action, a secret, an app to connect, a sign-in, the
    // browser, a tool to install. The phone names it and offers nothing to decide.
    macOnly: z.object({ kind: z.enum(['connector', 'secret', 'service', 'mcp', 'takeover', 'tool-install']), summary: z.string().max(280) }).nullable().optional(),
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
// POST .../chats/:chat with the decisions on the approval the chat waits on, instead of a message:
// one for each action the card shows, in order. It needs the phone's own "Approve requests"
// permission, which the right to send does not give. The Mac records them through its own card's path.
export const macPhoneDecisionSchema = z.object({
    requestId: z.string().uuid(),
    approval: z.object({
        toolCallId: z.string().min(1).max(256),
        decisions: z.array(z.discriminatedUnion('decision', [
            z.object({ decision: z.literal('approved') }).strict(),
            z.object({ decision: z.literal('declined'), note: z.string().max(20_000).optional() }).strict(),
        ])).min(1).max(20),
    }).strict(),
}).strict()
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

// GET /workspaces/:workspace/inbox: the Mac's Actions inbox. `state` says whether the row waits on a
// question, on an approval, on something only the Mac settles, or is a finished result. `id` is the
// Mac's to take apart: POST /workspaces/:workspace/inbox/read `{ ids }` marks rows read by it, by the
// Mac's own rule, and needs the send permission. Reading a waiting row never answers it.
export const macPhoneInboxItemSchema = z.object({
    id: z.string().min(3).max(8200),
    state: z.enum(['question', 'approval', 'on-mac', 'done']),
    agentId: savedId,
    agentName: z.string(),
    sessionId: savedId,
    sessionIds: z.array(savedId),
    title: z.string(),
    message: z.string().nullable(),
    updatedAt: z.string(),
    count: z.number().int().positive(),
})
export const macPhoneInboxSchema = z.object({ items: z.array(macPhoneInboxItemSchema), partial: z.boolean().optional() })
export type MacPhoneInboxItem = z.infer<typeof macPhoneInboxItemSchema>
export const macPhoneInboxReadSchema = z.object({ ids: z.array(z.string().min(3).max(8200)).min(1).max(500) }).strict()

// The Chief of Staff. GET /workspaces/:workspace/chief: `intake` while it still asks its first-run
// company questions, which are answered on the Mac (nothing else of it is served until then), and
// General with the task threads someone wrote in.
const chiefChatId = z.string().regex(/^fmc_[0-9a-f-]{36}$/)
export const macPhoneChiefConversationSchema = z.object({ id: chiefChatId, title: z.string().nullable(), kind: z.enum(['general', 'thread']), createdAt: z.string(), updatedAt: z.string() })
export const macPhoneChiefSchema = z.object({ state: z.enum(['ready', 'intake']), conversations: z.array(macPhoneChiefConversationSchema), permissions: sendPermission.optional() })
export type MacPhoneChiefConversation = z.infer<typeof macPhoneChiefConversationSchema>
// A card of the Chief of Staff that changes things once approved: a plan to build, changes to the
// team, a starter pack. In words only, with nothing that names it to the Mac: it is settled there.
export const macPhoneChiefCardSchema = z.object({ kind: z.enum(['plan', 'team-changes', 'starter']), title: z.string(), lines: z.array(z.string()) })
export type MacPhoneChiefCard = z.infer<typeof macPhoneChiefCardSchema>
// GET /workspaces/:workspace/chief/chat?chat=: one conversation, read as a coworker's chat is.
// `running` says a reply is being written, whoever started it.
export const macPhoneChiefChatSchema = z.object({
    state: z.enum(['ready', 'intake']),
    chat: macPhoneChiefConversationSchema.optional(),
    messages: z.array(macPhoneMessageSchema).default([]),
    running: z.boolean().default(false),
    pending: macPhonePendingSchema.optional(),
    cards: z.array(macPhoneChiefCardSchema).default([]),
    permissions: sendPermission.optional(),
})
export type MacPhoneChiefChat = z.infer<typeof macPhoneChiefChatSchema>
// POST /workspaces/:workspace/chief/send: a message in the conversation named, in a new task thread
// (`thread`), or in General when neither is given. The Mac sends it through the Chief of Staff's own
// path, with the model it chose. POST .../chief/answer answers the question a conversation waits on
// (no `answers` dismisses it), POST .../chief/stop stops the reply to a turn this phone started.
// All three need the send permission. GET .../chief/turn?chat=&request= and .../chief/stream follow
// such a turn, as a coworker's is followed.
export const macPhoneChiefSendSchema = z.object({ requestId: z.string().uuid(), text: z.string().min(1).max(20_000), chatId: chiefChatId.optional(), thread: z.literal(true).optional() }).strict()
export const macPhoneChiefAnswerSchema = z.object({ chatId: chiefChatId, requestId: z.string().uuid(), toolCallId: z.string().min(1).max(256), answers: z.array(z.array(z.string().max(4000)).max(100)).min(1).max(32).optional() }).strict()
export const macPhoneChiefStopSchema = z.object({ chatId: chiefChatId, requestId: z.string().uuid() }).strict()
// POST /workspaces/:workspace/voice/start: a voice conversation with the Chief of Staff, on the Chief of
// Staff conversation `chatId`. It needs the send permission and the Mac's own "talk from your phone"
// switch, and is limited to a few a minute per phone. The reply is a short-lived ElevenLabs
// conversation token for the phone's WebRTC session and the id of that conversation; the phone's
// audio goes to ElevenLabs and the Mac answers in text through its relay. Refusals: `not_found` (the
// feature is off on the Mac, or no such conversation), `unavailable` (the relay is not connected or
// ElevenLabs refused), `send_not_allowed`, `rate_limited`.
export const macPhoneVoiceStartSchema = z.object({ chatId: z.string().regex(/^fmc_[A-Za-z0-9-]{8,80}$/) }).strict()
export const macPhoneVoiceSessionSchema = z.object({
    conversationToken: z.string().min(1).max(8192),
    conversationId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    expiresAt: z.string(),
}).strict()
export type MacPhoneVoiceSession = z.infer<typeof macPhoneVoiceSessionSchema>

// Only a refusal from an approved settings operation may include a vetted Mac UI message.
export const macPhoneErrorSchema = z.union([
    z.object({ error: z.literal('settings_refused'), message: z.string().max(500) }),
    z.object({ error: z.string() }),
])

// The listener adds the device's own switch after the Mac projects this coworker. These
// deliberately small projections also strip unknown fields when reading a newer Mac.
const phoneModelPick = z.object({ connectionId: z.string().nullable(), model: z.string() })
const phoneToolRow = z.object({
    id: z.string(), label: z.string(), description: z.string(), enabled: z.boolean(),
    available: z.boolean(), unavailableReason: z.string().optional(), parent: z.string().optional(),
    confirmOnEnable: z.boolean(),
})
const phoneVerbosity = z.enum(['minimal', 'concise', 'normal', 'detailed'])
export const macPhoneCoworkerSettingsViewSchema = z.object({
    agentId: savedId, name: z.string(), description: z.string(), enabled: z.boolean(),
    settings: z.object({
        soul: z.string(), soulEditable: z.boolean(), verbosity: phoneVerbosity, repository: z.string().nullable(),
        workspaceReadEnabled: z.boolean(), suggestedReplies: z.boolean(), memoryEnabled: z.boolean(),
        autoMemory: z.boolean(), selfImprovementEnabled: z.boolean(),
    }),
    model: z.object({
        catalog: z.array(z.object({ connectionId: z.string(), name: z.string(), provider: z.string(), models: z.array(z.object({ id: z.string(), label: z.string() })) })),
        coworker: phoneModelPick.nullable(),
        effective: z.object({
            connectionId: z.string().nullable(), provider: z.string().nullable(), model: z.string().nullable(),
            label: z.string(), available: z.boolean(),
            reasoning: z.object({ effort: z.string(), source: z.enum(['model', 'workspace', 'model-default']) }).optional(),
            reasoningOptions: z.array(z.string()).optional(),
        }),
    }),
    tools: z.object({ rerun: z.array(phoneToolRow), codex: z.array(phoneToolRow) }),
    callTargets: z.object({
        targets: z.array(z.object({ agentId: savedId, name: z.string(), enabled: z.boolean(), callable: z.boolean() })),
        allowedTargetIds: z.array(savedId),
    }),
    setup: z.object({
        revision: z.string(), required: z.boolean().nullable(), pending: z.boolean(), skipped: z.boolean(), canStart: z.boolean(), canSkip: z.boolean(),
        completedAt: z.string().nullable(),
    }),
    board: z.object({ revision: z.number().int().nonnegative(), spaceId: z.string().nullable(), spaces: z.array(z.object({ id: z.string(), name: z.string() })) }),
})
export const macPhoneCoworkerSettingsSchema = macPhoneCoworkerSettingsViewSchema.extend({
    permissions: z.object({ changeSettings: z.boolean() }),
})
export type MacPhoneCoworkerSettings = z.infer<typeof macPhoneCoworkerSettingsSchema>

const settingId = z.string().trim().min(1).max(256)
const phoneTargets = z.array(z.string().uuid()).max(100)
const settingsBody = z.strictObject({
    description: z.string().trim().max(2000).optional(),
    soul: z.string().trim().min(1).max(100_000).optional(), verbosity: phoneVerbosity.optional(),
    suggestedReplies: z.boolean().optional(), memoryEnabled: z.boolean().optional(), autoMemory: z.boolean().optional(),
    repository: z.string().trim().max(300).nullable().optional(),
}).refine(body => Object.keys(body).length > 0)
// The URL names the coworker. No variant accepts an engine ID, arbitrary route, credential,
// conversation override, another coworker's board move, or an operation that edits setup text.
export const macPhoneCoworkerSettingsChangeSchema = z.discriminatedUnion('field', [
    z.strictObject({ field: z.literal('name'), body: z.strictObject({ name: z.string().trim().min(1).max(60) }) }),
    z.strictObject({ field: z.literal('settings'), body: settingsBody }),
    z.strictObject({ field: z.literal('enabled'), body: z.strictObject({ enabled: z.boolean() }) }),
    z.strictObject({ field: z.literal('model'), body: z.discriminatedUnion('action', [
        z.strictObject({ action: z.literal('coworker'), connectionId: settingId, model: settingId }),
        z.strictObject({ action: z.literal('follow-workspace') }),
    ]) }),
    z.strictObject({ field: z.literal('effort'), body: z.strictObject({ connectionId: settingId, model: settingId, effort: z.string().trim().min(1).max(32).nullable() }) }),
    z.strictObject({ field: z.literal('tools'), body: z.strictObject({ group: z.enum(['rerun', 'codex']), id: settingId, enabled: z.boolean() }) }),
    z.strictObject({ field: z.literal('call-targets'), body: z.strictObject({ targetAgentIds: phoneTargets, expectedTargetAgentIds: phoneTargets }) }),
    z.strictObject({ field: z.literal('box'), body: z.strictObject({ spaceId: z.uuid(), requestId: z.uuid(), expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }) }),
    z.strictObject({ field: z.literal('setup'), body: z.strictObject({ action: z.enum(['start', 'skip']), requestId: z.uuid(), expectedRevision: z.string().min(1).max(256) }) }),
])
export type MacPhoneCoworkerSettingsChange = z.infer<typeof macPhoneCoworkerSettingsChangeSchema>
