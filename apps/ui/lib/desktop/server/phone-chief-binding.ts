import 'server-only'
import type { DesktopForemanChatRef } from '@rerun/contracts'
import { z } from 'zod'
import { EngineRequestError, getRun, getSessionMessages } from '@/lib/engine/client'
import { DesktopHttpError } from './auth'
import { ForemanRefusal } from './foreman/authority'
import { desktopForeman } from './foreman/binding'
import { foremanTurn, ownedForemanChat } from './foreman/chat-store'
import { ForemanError } from './foreman/runtime'
import { readDesktopTeamChanges } from './foreman/team-changes'
import { createSqliteDesktopForemanIntakeStore } from './foreman-intake/store'
import { phoneChiefCards, phoneChiefInIntake, phoneChiefMessages } from './phone-chief'
import { phonePendingCards } from './phone-pending'
import type { DesktopRuntime } from './runtime'
import { engineOf } from './settings'

export const phoneChiefOptions = { headers: { 'cache-control': 'no-store' } }
export const phoneChiefChatId = z.string().regex(/^fmc_[0-9a-f-]{36}$/)

type App = Awaited<ReturnType<typeof desktopForeman>>

export function phoneChiefChat(runtime: DesktopRuntime, chatId: string | null): DesktopForemanChatRef {
    const parsed = phoneChiefChatId.safeParse(chatId)
    if (!parsed.success) throw new DesktopHttpError(404, 'Not found')
    return { workspaceId: String(runtime.workspaceId), chatId: parsed.data }
}

// Whether the Chief of Staff still asks its first-run company questions, by the rule the Mac's own
// panel follows. They are answered on the Mac: a phone is told so and is served nothing else of it.
export async function phoneChiefIntake(runtime: DesktopRuntime, app: App): Promise<boolean> {
    const workspaceId = String(runtime.workspaceId)
    const home = (await app.db.execute({ sql: 'SELECT chat_id, engine_session_id FROM desktop_foreman_chats WHERE workspace_id=? AND home=1', args: [workspaceId] })).rows[0]
    // Never opened on this Mac: it opens on the questions.
    if (!home) return true
    const { session, completion } = await createSqliteDesktopForemanIntakeStore(app.db, { schemaReady: true }).read({ workspaceId, chatId: String(home.chat_id) })
    const finished = completion?.state === 'acknowledged'
    const savedProgress = session.revision > 0 || completion !== null
    if (finished || savedProgress) return phoneChiefInIntake({ finished, savedProgress, messageCount: 0 })
    const messages = await getSessionMessages(engineOf(runtime), 'foreman', String(home.engine_session_id), { requireSuccess: true, signal: AbortSignal.timeout(10_000) }).catch(error => {
        if (error instanceof EngineRequestError && error.status === 404) return []
        throw error
    })
    return phoneChiefInIntake({ finished, savedProgress, messageCount: messages.length })
}

// One conversation, as the Mac's own panel reads it, reduced to what a phone is shown.
export async function readPhoneChiefChat(runtime: DesktopRuntime, app: App, chat: DesktopForemanChatRef) {
    await ownedForemanChat(app.db, chat)
    const state = await app.state(chat)
    const messages = phoneChiefMessages(state.messages as Parameters<typeof phoneChiefMessages>[0])
    const teamChanges = await readDesktopTeamChanges(app.db, chat).catch(() => null)
    const dates = (await app.db.execute({ sql: 'SELECT MIN(created_at) AS started, MAX(created_at) AS updated, (SELECT title FROM desktop_foreman_chats WHERE chat_id=?) AS title FROM desktop_foreman_turns WHERE chat_id=?', args: [chat.chatId, chat.chatId] })).rows[0]
    const updatedAt = typeof dates?.updated === 'string' ? dates.updated : new Date(0).toISOString()
    return {
        chat: {
            id: chat.chatId, title: typeof dates?.title === 'string' ? dates.title : null, kind: state.separateConversation ? 'thread' as const : 'general' as const,
            createdAt: typeof dates?.started === 'string' ? dates.started : updatedAt, updatedAt,
        },
        messages,
        // A reply is being written, whoever started it: nothing else is taken until it settles.
        running: state.view.live !== null,
        pending: { ...phonePendingCards(state.question, state.approval), macOnly: null },
        cards: phoneChiefCards({ revisions: state.view.revisions, currentRevisionId: state.view.currentRevisionId, teamChanges, starter: state.starter, messageCount: messages.length }),
    }
}

// The turn a phone started, found by the id the pairing service made for it. A turn of another
// conversation or workspace does not exist for it.
export async function phoneChiefTurn(runtime: DesktopRuntime, app: App, chat: DesktopForemanChatRef, runId: string) {
    const turn = await foremanTurn(app.db, runId)
    if (!turn || turn.body.binding.runId !== runId || turn.body.binding.chatId !== chat.chatId || turn.body.binding.workspaceId !== chat.workspaceId) throw new DesktopHttpError(404, 'Not found')
    try {
        const run = await getRun(engineOf(runtime), 'foreman', runId, { signal: AbortSignal.timeout(8000) })
        if (run.id !== runId || run.agentId !== 'foreman' || run.sessionId !== turn.body.sessionId) throw new DesktopHttpError(404, 'Not found')
        return run
    } catch (error) {
        // Saved, and never started: the engine does not know it.
        if (error instanceof EngineRequestError && error.status === 404) return null
        throw error
    }
}

// What the Chief of Staff's own route answers its refusals with.
export async function phoneChiefAction(work: () => Promise<Response>): Promise<Response> {
    try {
        return await work()
    } catch (error) {
        if (error instanceof ForemanRefusal) throw new DesktopHttpError(409, error.message)
        if (error instanceof ForemanError) throw new DesktopHttpError(error.code === 'not_found' ? 404 : 409, error.message)
        throw error
    }
}
