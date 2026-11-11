import 'server-only'
import type { Client } from '@libsql/client'
import { desktopTemplateListSchema, type DesktopForemanChatRef } from '@rerun/contracts'
import { z } from 'zod'
import { request } from '@/lib/engine/client'
import { DesktopHttpError } from '../auth'
import { ownedForemanChat } from '../foreman/chat-store'
import type { DesktopRuntime } from '../runtime'
import { engineOf } from '../settings'
import { assertDesktopWorkspaceAdmission } from '../workspace-admission'
import { createDesktopLocalStarterOffers, type DesktopLocalStarterOffer } from './local-offer'
import { starterChoiceSchema } from './repository'

export const localStarterDecisionSchema = z.strictObject({
    offerId: z.uuid(),
    intakeRequestId: z.uuid(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    choice: starterChoiceSchema,
})
export type DesktopLocalStarterDecision = z.infer<typeof localStarterDecisionSchema>
type Decision = { offer: DesktopLocalStarterOffer; choice: DesktopLocalStarterDecision['choice'] }
const stale = () => new DesktopHttpError(409, 'This starter offer changed. Reopen Foreman before answering.')

export function createDesktopLocalStarterDecisions(runtime: DesktopRuntime, db: Client) {
    const offers = createDesktopLocalStarterOffers(runtime, db)
    function matches(offer: DesktopLocalStarterOffer | null, input: DesktopLocalStarterDecision): offer is DesktopLocalStarterOffer {
        return !!offer && offer.id === input.offerId && offer.digest === input.digest
    }

    async function recover(chat: DesktopForemanChatRef, input: DesktopLocalStarterDecision): Promise<Decision | null> {
        const offer = await offers.readDecided(chat, input.intakeRequestId)
        if (!offer) return null
        if (!matches(offer, input)) throw stale()
        const row = (await db.execute({
            sql: `SELECT d.choice FROM desktop_foreman_local_starter_decisions d
                  JOIN desktop_foreman_local_starter_offers o ON o.id=d.offer_id AND o.withdrawn=0
                  WHERE d.offer_id=? AND NOT EXISTS
                    (SELECT 1 FROM desktop_foreman_local_starter_stops s WHERE s.intake_request_id=o.intake_request_id)
                    AND NOT EXISTS (SELECT 1 FROM desktop_foreman_turns t WHERE t.chat_id=o.chat_id AND t.request_id<>o.id)`,
            args: [offer.id],
        })).rows[0]
        assertDesktopWorkspaceAdmission(runtime)
        if (!row || row.choice !== JSON.stringify(input.choice)) throw stale()
        return { offer, choice: input.choice }
    }

    return {
        /** The caller owns the same Foreman chat lock as Stop and turn admission. */
        async reserve(chat: DesktopForemanChatRef, raw: DesktopLocalStarterDecision, signal: AbortSignal): Promise<Decision> {
            const parsed = localStarterDecisionSchema.safeParse(raw)
            if (!parsed.success) throw new DesktopHttpError(400, 'This starter choice was not understood.')
            const input = parsed.data
            if (input.choice.kind === 'cards') {
                if (new Set(input.choice.chosen).size !== input.choice.chosen.length) throw stale()
                input.choice.chosen.sort()
            }
            signal.throwIfAborted()
            const saved = await recover(chat, input)
            if (saved) return saved
            const offer = await offers.read(chat, input.intakeRequestId)
            if (!matches(offer, input)) throw stale()
            if (input.choice.kind === 'cards') {
                const ids = new Set(input.choice.chosen)
                const chosen = offer.cards.filter(card => ids.has(card.templateId))
                if (chosen.length !== ids.size) throw stale()
                const { templates } = await request(engineOf(runtime), '/desktop/templates', {
                    method: 'GET', redirect: 'error', cache: 'no-store', signal,
                }, data => desktopTemplateListSchema.parse(data))
                if (chosen.some(card => !templates.some(template => template.templateId === card.templateId
                    && template.revision === card.revision && template.status === 'captured' && template.coworkerCount > 0))) throw stale()
            }
            signal.throwIfAborted()
            assertDesktopWorkspaceAdmission(runtime)
            // Only an acknowledged application-authored intake can accept a
            // choice. A renderer request, changed snapshot, Stop, or later turn
            // cannot win the insert. The offer ID doubles as the stable text run ID.
            await db.execute({
                sql: `INSERT INTO desktop_foreman_local_starter_decisions(offer_id,choice)
                      SELECT o.id,? FROM desktop_foreman_local_starter_offers o
                      JOIN desktop_foreman_chats c ON c.chat_id=o.chat_id AND c.workspace_id=o.workspace_id AND c.engine_session_id=o.session_id
                      JOIN desktop_foreman_intake_completions i ON i.request_id=o.intake_request_id AND i.fingerprint=o.intake_fingerprint
                      WHERE o.id=? AND o.workspace_id=? AND o.chat_id=? AND o.digest=? AND o.withdrawn=0
                        AND i.state='acknowledged' AND json_extract(i.body,'$.followUp.conversationId')=o.session_id
                        AND json_type(i.body,'$.followUp.runId')='null'
                        AND NOT EXISTS (SELECT 1 FROM desktop_foreman_local_starter_stops s WHERE s.intake_request_id=i.request_id)
                        AND NOT EXISTS (SELECT 1 FROM desktop_foreman_turns t WHERE t.chat_id=o.chat_id)
                      ON CONFLICT(offer_id) DO NOTHING`,
                args: [JSON.stringify(input.choice), offer.id, chat.workspaceId, chat.chatId, offer.digest],
            })
            signal.throwIfAborted()
            const accepted = await recover(chat, input)
            if (!accepted) throw stale()
            return accepted
        },
        /** Fence the exact reserved intake even if the catalog request is still in flight. */
        async stop(chat: DesktopForemanChatRef) {
            if (chat.workspaceId !== String(runtime.workspaceId)) throw new DesktopHttpError(404, 'Foreman conversation not found.')
            await ownedForemanChat(db, chat)
            await db.execute({
                sql: `INSERT INTO desktop_foreman_local_starter_stops(intake_request_id)
                      SELECT request_id FROM desktop_foreman_intake_completions
                      WHERE workspace_id=? AND chat_id=? AND json_type(body,'$.answers.ownAsk') IS NULL
                        AND (state IN ('pending','uncertain','failed')
                             OR state='acknowledged' AND json_type(body,'$.followUp.runId')='null')
                      ON CONFLICT(intake_request_id) DO NOTHING`,
                args: [chat.workspaceId, chat.chatId],
            })
        },
    }
}
