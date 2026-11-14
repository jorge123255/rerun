import { z } from 'zod'
import { desktopForemanDockExtrasSchema } from '@/lib/desktop/foreman-dock/schema'
import { desktopCoworkerMentionsSchema, desktopDocumentSendSelectionSchema, FOREMAN_AGENT_ID, foremanChatRefSchema, foremanModelRefSchema, foremanDecisionInputSchema, foremanRevisionIdSchema, validDesktopCoworkerMentionFields } from '@rerun/contracts'
import { sameForemanChat } from './identity'

const pendingSendSchema = z.strictObject({
    requestId: z.uuid(), text: z.string().max(20_000), modelChoice: foremanModelRefSchema.nullable(),
    documents: desktopDocumentSendSelectionSchema.optional(),
    coworkerMentions: desktopCoworkerMentionsSchema.optional(),
}).refine(value => Boolean(value.text || value.documents)).refine(validDesktopCoworkerMentionFields)
const decisionSchema = z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('idle') }),
    z.strictObject({ status: z.literal('pending'), request: foremanDecisionInputSchema, startedAt: z.number().finite() }),
    z.strictObject({ status: z.literal('acknowledged'), request: foremanDecisionInputSchema, decisionId: z.string(), at: z.number().finite() }),
    z.strictObject({ status: z.enum(['failed', 'uncertain']), request: foremanDecisionInputSchema, error: z.string().max(8192), at: z.number().finite() }),
])
const size = z.number().finite().min(100).max(4096)
export const desktopForemanSavedUiSchema = z.strictObject({
    workspaceId: foremanChatRefSchema.shape.workspaceId, chatId: foremanChatRefSchema.shape.chatId,
    open: z.boolean(), tab: z.enum(['assistant', 'routines']), draft: z.string().max(20_000),
    draftCoworkerMentions: desktopCoworkerMentionsSchema.optional(),
    pendingPlanRevisionId: foremanRevisionIdSchema.nullable(), decision: decisionSchema,
    placement: z.discriminatedUnion('mode', [
        z.strictObject({ mode: z.literal('dock'), side: z.enum(['left', 'right']), width: size, height: size, dockWidth: size }),
        z.strictObject({ mode: z.literal('float'), corner: z.enum(['top-left', 'top-right', 'bottom-left', 'bottom-right']), width: size, height: size, dockWidth: size }),
    ]),
    // Plans, build and discoveries always come from the canonical current conversation view.
    build: z.unknown().transform(() => null), discoveries: z.unknown().transform(() => null),
    pendingSend: pendingSendSchema.optional(),
    dock: desktopForemanDockExtrasSchema.optional(),
}).refine(value => value.decision.status === 'idle' || sameForemanChat(value, value.decision.request.chat), 'Saved decision belongs to another chat.')
    .refine(value => validDesktopCoworkerMentionFields({ text: value.draft, coworkerMentions: value.draftCoworkerMentions }), 'Saved mentions do not match the draft.')
    .refine(value => {
        const scope = value.pendingSend?.documents?.scope
        return !scope || scope.agentId === FOREMAN_AGENT_ID && scope.tabUid === value.chatId && !!scope.sessionId
    }, 'Saved attachments belong to another chat.')
