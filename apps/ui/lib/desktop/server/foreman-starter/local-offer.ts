import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import type { Client } from '@libsql/client'
import {
    DESKTOP_TEMPLATE_LIMITS,
    desktopTemplateIdSchema,
    desktopTemplateListSchema,
    desktopTemplateRevisionSchema,
    type DesktopForemanChatRef,
} from '@rerun/contracts'
import { z } from 'zod'
import { request } from '@/lib/engine/client'
import { DesktopHttpError } from '../auth'
import { ownedForemanChat, withForemanChatWrite } from '../foreman/chat-store'
import { readDesktopForemanIntakeReceipt } from '../foreman/intake-profile'
import type { DesktopRuntime } from '../runtime'
import { engineOf } from '../settings'
import { assertDesktopWorkspaceAdmission } from '../workspace-admission'

const maxCards = 24
const cardSchema = z.strictObject({
    templateId: desktopTemplateIdSchema,
    revision: desktopTemplateRevisionSchema,
    title: z.string().min(1).max(DESKTOP_TEMPLATE_LIMITS.maxTitleLength),
})
const cardsSchema = z.array(cardSchema).min(1).max(maxCards)
type Card = z.infer<typeof cardSchema>
export type DesktopLocalStarterOffer = {
    id: string
    chat: DesktopForemanChatRef
    sessionId: string
    intakeRequestId: string
    intakeFingerprint: string
    digest: string
    cards: Card[]
}
const fingerprint = (offer: Omit<DesktopLocalStarterOffer, 'id' | 'digest'>) => createHash('sha256').update(JSON.stringify([
    'desktop-local-starter-v1', offer.chat.workspaceId, offer.chat.chatId, offer.sessionId,
    offer.intakeRequestId, offer.intakeFingerprint, offer.cards,
])).digest('hex')
const unavailable = () => new DesktopHttpError(503, 'The saved Foreman starter offer could not be confirmed.')

/**
 * Original Rerun's offer is an app-scripted intake event. This producer records
 * that source explicitly. An engine message, run, or renderer part cannot mint it.
 */
export function createDesktopLocalStarterOffers(runtime: DesktopRuntime, db: Client) {
    async function intake(chat: DesktopForemanChatRef, requestId: string) {
        if (chat.workspaceId !== String(runtime.workspaceId)) throw new DesktopHttpError(404, 'Foreman conversation not found.')
        const owner = await ownedForemanChat(db, chat)
        const receipt = await readDesktopForemanIntakeReceipt(db, chat, requestId)
        // A custom ask already supplies the next turn. An acknowledged intake is
        // eligible only if it was settled without admitting an engine turn.
        if (!receipt || receipt.answers.ownAsk || receipt.state === 'unavailable'
            || receipt.state === 'acknowledged' && (receipt.followUp?.runId !== null || receipt.followUp.conversationId !== owner.sessionId)) return null
        return { owner, receipt }
    }

    async function readOffer(chat: DesktopForemanChatRef, requestId: string, receiptOnly: boolean): Promise<DesktopLocalStarterOffer | null> {
        assertDesktopWorkspaceAdmission(runtime)
        const source = await intake(chat, requestId)
        if (!source) return null
        const row = (await db.execute({
            sql: `SELECT o.id, o.digest, o.cards FROM desktop_foreman_local_starter_offers o
                  JOIN desktop_foreman_intake_completions i ON i.request_id=o.intake_request_id AND i.fingerprint=o.intake_fingerprint
                  JOIN desktop_foreman_chats c ON c.chat_id=o.chat_id AND c.workspace_id=o.workspace_id AND c.engine_session_id=o.session_id
                  WHERE o.workspace_id=? AND o.chat_id=? AND o.session_id=? AND o.intake_request_id=?
                    AND o.intake_fingerprint=? AND i.state=? AND i.updated_at=? AND o.withdrawn=0
                    AND NOT EXISTS (SELECT 1 FROM desktop_foreman_local_starter_stops s WHERE s.intake_request_id=i.request_id)
                    AND (${receiptOnly
                        ? 'EXISTS (SELECT 1 FROM desktop_foreman_local_starter_decisions d WHERE d.offer_id=o.id)'
                        : `NOT EXISTS (SELECT 1 FROM desktop_foreman_local_starter_decisions d WHERE d.offer_id=o.id)
                           AND NOT EXISTS (SELECT 1 FROM desktop_foreman_turns t WHERE t.chat_id=o.chat_id)`})`,
            args: [chat.workspaceId, chat.chatId, source.owner.sessionId, requestId, source.receipt.fingerprint, source.receipt.state, source.receipt.updatedAt],
        })).rows[0]
        assertDesktopWorkspaceAdmission(runtime)
        if (!row) return null
        try {
            const base = { chat, sessionId: source.owner.sessionId, intakeRequestId: requestId, intakeFingerprint: source.receipt.fingerprint,
                cards: cardsSchema.parse(JSON.parse(String(row.cards))) }
            if (fingerprint(base) !== row.digest) throw unavailable()
            return { ...base, id: z.uuid().parse(row.id), digest: String(row.digest) }
        } catch { throw unavailable() }
    }
    const read = (chat: DesktopForemanChatRef, requestId: string) => readOffer(chat, requestId, false)

    return {
        read,
        readDecided: (chat: DesktopForemanChatRef, requestId: string) => readOffer(chat, requestId, true),
        async stopped(chat: DesktopForemanChatRef, requestId: string) {
            return !!(await db.execute({
                sql: `SELECT 1 FROM desktop_foreman_local_starter_stops s
                      JOIN desktop_foreman_intake_completions i ON i.request_id=s.intake_request_id
                      WHERE i.workspace_id=? AND i.chat_id=? AND i.request_id=?`,
                args: [chat.workspaceId, chat.chatId, requestId],
            })).rows[0]
        },
        /** Called only by the server that owns completion of this exact intake. */
        async prepare(chat: DesktopForemanChatRef, requestId: string, intakeFingerprint: string, signal: AbortSignal): Promise<DesktopLocalStarterOffer | null> {
            signal.throwIfAborted()
            assertDesktopWorkspaceAdmission(runtime)
            const source = await intake(chat, requestId)
            if (!source || source.receipt.fingerprint !== intakeFingerprint) return null
            const existing = await read(chat, requestId)
            if (existing) return existing
            const ineligible = (await db.execute({
                sql: `SELECT 1 FROM desktop_foreman_turns WHERE chat_id=?
                      UNION ALL SELECT 1 FROM desktop_foreman_local_starter_offers WHERE chat_id=?
                      UNION ALL SELECT 1 FROM desktop_foreman_local_starter_stops WHERE intake_request_id=? LIMIT 1`,
                args: [chat.chatId, chat.chatId, requestId],
            })).rows[0]
            if (ineligible) return null
            const { templates } = await request(engineOf(runtime), '/desktop/templates', {
                method: 'GET', cache: 'no-store', redirect: 'error', signal,
            }, data => desktopTemplateListSchema.parse(data))
            const cards: Card[] = []
            const seen = new Set<string>()
            for (const template of templates) {
                const title = template.title.trim().slice(0, DESKTOP_TEMPLATE_LIMITS.maxTitleLength)
                if (template.status !== 'captured' || !template.revision || template.coworkerCount < 1 || !title || seen.has(template.templateId)) continue
                cards.push({ templateId: template.templateId, revision: template.revision, title })
                seen.add(template.templateId)
                if (cards.length === maxCards) break
            }
            if (!cards.length) return null
            const base = { chat, sessionId: source.owner.sessionId, intakeRequestId: requestId, intakeFingerprint, cards }
            return withForemanChatWrite(db, async () => {
                signal.throwIfAborted()
                assertDesktopWorkspaceAdmission(runtime)
                // Recheck ownership and intake after the catalog request. Stop and
                // ordinary turn admission serialize against the final publication.
                await db.execute({
                    sql: `INSERT INTO desktop_foreman_local_starter_offers(id, workspace_id, chat_id, session_id, intake_request_id, intake_fingerprint, digest, cards)
                          SELECT ?, c.workspace_id, c.chat_id, c.engine_session_id, i.request_id, i.fingerprint, ?, ?
                          FROM desktop_foreman_chats c JOIN desktop_foreman_intake_completions i ON i.chat_id=c.chat_id AND i.workspace_id=c.workspace_id
                          WHERE c.workspace_id=? AND c.chat_id=? AND c.engine_session_id=? AND i.request_id=? AND i.fingerprint=? AND i.state=? AND i.updated_at=?
                            AND NOT EXISTS (SELECT 1 FROM desktop_foreman_turns t WHERE t.chat_id=c.chat_id)
                            AND NOT EXISTS (SELECT 1 FROM desktop_foreman_local_starter_stops s WHERE s.intake_request_id=i.request_id)
                          ON CONFLICT(chat_id) DO NOTHING`,
                    args: [randomUUID(), fingerprint(base), JSON.stringify(cards), chat.workspaceId, chat.chatId,
                        base.sessionId, requestId, intakeFingerprint, source.receipt.state, source.receipt.updatedAt],
                })
                signal.throwIfAborted()
                return read(chat, requestId)
            })
        },
        async withdraw(chat: DesktopForemanChatRef, offerId: string) {
            if (chat.workspaceId !== String(runtime.workspaceId)) throw new DesktopHttpError(404, 'Foreman conversation not found.')
            const owner = await ownedForemanChat(db, chat)
            assertDesktopWorkspaceAdmission(runtime)
            const result = await db.execute({
                sql: 'UPDATE desktop_foreman_local_starter_offers SET withdrawn=1 WHERE workspace_id=? AND chat_id=? AND session_id=? AND id=? AND withdrawn=0',
                args: [chat.workspaceId, chat.chatId, owner.sessionId, offerId],
            })
            return result.rowsAffected === 1
        },
    }
}
