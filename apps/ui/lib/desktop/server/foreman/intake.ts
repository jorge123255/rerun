import 'server-only'
import { createHash } from 'node:crypto'
import type { Client } from '@libsql/client'
import {
    desktopForemanIntakeAnswersSchema,
    foremanBindingSchema,
    foremanChatRefSchema,
    type DesktopForemanChatRef,
    type DesktopForemanIntakeAnswers,
    type DesktopForemanIntakeCompletionAuthority,
} from '@rerun/contracts'
import { EngineRequestError, getRun } from '@/lib/engine/client'
import { DesktopHttpError } from '../auth'
import { createDesktopForemanIntakeService, createSqliteDesktopForemanIntakeStore, fingerprintIntakeAnswers, type DesktopForemanIntakeService } from '../foreman-intake'
import type { DesktopRuntime } from '../runtime'
import { engineOf } from '../settings'
import { assertDesktopWorkspaceAdmission } from '../workspace-admission'
import { foremanTurn, ownedForemanChat } from './chat-store'
import { readDesktopForemanIntakeReceipt } from './intake-profile'
import type { createDesktopLocalStarterOffers } from '../foreman-starter/local-offer'

type IntakeApp = {
    db: Client
    starterOffers?: ReturnType<typeof createDesktopLocalStarterOffers>
    send(chat: DesktopForemanChatRef, requestId: string, text: string): Promise<{ runId: string }>
}
const notConfirmed = () => new DesktopHttpError(503, 'The original Foreman intake message could not be confirmed. Retry the same intake.')

/** Stable user turn, with answers as data and no invented company details or creation approval. */
export function foremanIntakeMessage(answers: DesktopForemanIntakeAnswers): string {
    const canonical = desktopForemanIntakeAnswersSchema.parse(answers)
    return [
        'These are my company intake answers:',
        JSON.stringify(canonical, null, 2),
        canonical.ownAsk
            ? 'The ownAsk field is what I want help with. Use it and the intake answers to propose a plan for review in this same Foreman conversation.'
            : 'Continue in this same Foreman conversation. Ask what work I need help with, then use my answers to propose a plan for review.',
        'Treat missing company details as unknown. If a website was supplied, you may use read_company in this live conversation; do not claim to have researched it before reading it.',
        'Never create coworkers, install a template, create Boxes, or start setup from this intake. Show the proposed plan and wait until I review and explicitly confirm it through the plan card.',
    ].join('\n\n')
}

/** Uses root's existing database, exact Foreman chat and send journal as its only effect authority. */
export function createDesktopForemanIntakeBinding(runtime: DesktopRuntime, app: IntakeApp): DesktopForemanIntakeService {
    const own = async (chat: DesktopForemanChatRef) => {
        chat = foremanChatRefSchema.parse(chat)
        if (chat.workspaceId !== String(runtime.workspaceId)) throw new DesktopHttpError(404, 'Foreman conversation not found.')
        return ownedForemanChat(app.db, chat)
    }
    const reserved = async (input: { chat: DesktopForemanChatRef; requestId: string; fingerprint: string }) => {
        const owner = await own(input.chat)
        const receipt = await readDesktopForemanIntakeReceipt(app.db, input.chat, input.requestId)
        if (!receipt || receipt.state === 'unavailable' || receipt.fingerprint !== input.fingerprint) throw notConfirmed()
        return { owner, receipt }
    }
    const completion: DesktopForemanIntakeCompletionAuthority = {
        async lookup(input) {
            const { owner, receipt } = await reserved(input)
            const turn = await foremanTurn(app.db, input.requestId)
            const industry = receipt.answers.industry ?? receipt.answers.decidedIndustry
            if (!turn) {
                if (await app.starterOffers?.read(input.chat, input.requestId) || await app.starterOffers?.stopped(input.chat, input.requestId)) {
                    return { ...input, conversationId: owner.sessionId, runId: null, industry }
                }
                return null
            }
            const binding = foremanBindingSchema.safeParse(turn.body.binding)
            const expectedText = foremanIntakeMessage(receipt.answers)
            const expectedFingerprint = createHash('sha256').update(JSON.stringify([input.chat, expectedText, null])).digest('hex')
            const indexed = (await app.db.execute({ sql: 'SELECT chat_id FROM desktop_foreman_turns WHERE request_id=?', args: [input.requestId] })).rows[0]
            if (!binding.success || !indexed || String(indexed.chat_id) !== input.chat.chatId
                || binding.data.workspaceId !== input.chat.workspaceId || binding.data.chatId !== input.chat.chatId || binding.data.runId !== input.requestId
                || turn.body.sessionId !== owner.sessionId || turn.body.text !== expectedText || turn.fingerprint !== expectedFingerprint) throw notConfirmed()

            // Canonical send records admitted only after engine headers match its exact run/session.
            if (turn.status !== 'admitted' && turn.status !== 'finished') {
                if (turn.status !== 'pending' && turn.status !== 'failed') throw notConfirmed()
                try {
                    const run = await getRun(engineOf(runtime), 'foreman', input.requestId, { signal: AbortSignal.timeout(10_000) })
                    if (run.id !== input.requestId || run.agentId !== 'foreman' || run.sessionId !== owner.sessionId) throw notConfirmed()
                } catch (error) {
                    if (error instanceof EngineRequestError && error.status === 404) return null
                    throw notConfirmed()
                }
            }
            return { ...input, conversationId: owner.sessionId, runId: input.requestId, industry }
        },
        async deliver(input) {
            assertDesktopWorkspaceAdmission(runtime)
            const { owner, receipt } = await reserved(input)
            if (fingerprintIntakeAnswers(input.answers, input.chat, input.requestId) !== receipt.fingerprint) throw notConfirmed()
            const offer = await app.starterOffers?.prepare(input.chat, input.requestId, receipt.fingerprint, AbortSignal.timeout(10_000))
            const withoutRun = { conversationId: owner.sessionId, runId: null, industry: receipt.answers.industry ?? receipt.answers.decidedIndustry }
            if (offer || await app.starterOffers?.stopped(input.chat, input.requestId)) return withoutRun
            const result = await app.send(input.chat, input.requestId, foremanIntakeMessage(receipt.answers)).catch(async error => {
                if (await app.starterOffers?.stopped(input.chat, input.requestId)) return null
                throw error
            })
            if (!result) return withoutRun
            if (result.runId !== input.requestId) throw notConfirmed()
            const confirmed = await completion.lookup(input)
            if (!confirmed) throw notConfirmed()
            return { conversationId: confirmed.conversationId, runId: confirmed.runId, industry: confirmed.industry }
        },
    }
    const service = createDesktopForemanIntakeService({
        store: createSqliteDesktopForemanIntakeStore(app.db, { schemaReady: true }), completion,
        industry: null, site: null, knownName: null,
    })
    return {
        ...service,
        read: async chat => { await own(chat); return service.read(chat) },
        save: async input => { await own(input.chat); return service.save(input) },
        complete: async input => { await own(input.chat); return service.complete(input) },
        lookupCompletion: async (chat, requestId) => { await own(chat); return service.lookupCompletion(chat, requestId) },
    }
}
