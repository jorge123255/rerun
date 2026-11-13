import 'server-only'
import { sessionSourceSchema, type DesktopAutomationResult, type SessionSource } from '@rerun/contracts'
import type { DesktopSessionKind } from '../general-threads'
import type { DesktopSession } from './store'

export const PENDING_QUESTION_READ_CONCURRENCY = 4

export type DesktopHistoryEngineSession = {
    id: string
    agentId: string
    source: SessionSource
    updatedAt: string
    automationResult?: DesktopAutomationResult
}

export type DesktopChatHistoryDependencies = {
    listLocalSessions: (agentId: string) => Promise<DesktopSession[]>
    listEngineSessions: (engineAgentId: string) => Promise<DesktopHistoryEngineSession[]>
    /** Receives the local desktop session id of a conversation already scoped to the selected coworker. */
    pendingQuestionFor?: (sessionId: string) => Promise<string | null>
}

export type DesktopChatHistoryConversation = {
    id: string
    agentId: string
    engineSessionId: string
    title: string
    createdAt: string
    updatedAt: string
    source: SessionSource | null
    needsYou: boolean
    pendingQuestion: string | null
    kind: DesktopSessionKind
    firstMessage: string | null
    automationOutcome?: DesktopAutomationResult['outcome']
}

export type DesktopChatHistory = {
    conversations: DesktopChatHistoryConversation[]
    enrichment: 'ok' | 'unavailable'
    questions: 'ok' | 'unavailable' | 'not-requested'
}

type HistoryAgent = { id: string; engineAgentId: string }

function updatedTime(value: string): number {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : 0
}

async function forEachLimited<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
    let next = 0
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        for (;;) {
            const index = next++
            if (index >= items.length) return
            await run(items[index])
        }
    })
    await Promise.all(workers)
}

async function readPendingQuestions(sessions: readonly DesktopSession[], pendingQuestionFor: NonNullable<DesktopChatHistoryDependencies['pendingQuestionFor']>) {
    const labels = new Map<string, string>()
    let failed = false
    await forEachLimited(sessions, PENDING_QUESTION_READ_CONCURRENCY, async session => {
        try {
            const label = (await pendingQuestionFor(session.id))?.trim()
            if (label) labels.set(session.id, label)
        } catch {
            failed = true
        }
    })
    return { labels, status: failed ? 'unavailable' as const : 'ok' as const }
}

export async function readDesktopChatHistory(dependencies: DesktopChatHistoryDependencies, agent: HistoryAgent): Promise<DesktopChatHistory> {
    const localSessions = (await dependencies.listLocalSessions(agent.id)).filter(session => session.agentId === agent.id)
    const seen = new Set<string>()
    const ownedSessions = localSessions.filter(session => {
        if (seen.has(session.id)) return false
        seen.add(session.id)
        return true
    })

    let engineSessions: DesktopHistoryEngineSession[] | null = null
    try {
        engineSessions = (await dependencies.listEngineSessions(agent.engineAgentId)).filter(session => session.agentId === agent.engineAgentId)
    } catch {
        engineSessions = null
    }
    // A missing/invalid association is unknown, including a successful but incomplete engine
    // listing. It must not be classified as an ordinary chat or advertised as an empty filter.
    const engineById = new Map((engineSessions ?? []).filter(session =>
        sessionSourceSchema.safeParse(session.source).success && Number.isFinite(Date.parse(session.updatedAt))
    ).map(session => [session.id, session]))
    const { labels, status: questions } = dependencies.pendingQuestionFor
        ? await readPendingQuestions(ownedSessions, dependencies.pendingQuestionFor)
        : { labels: new Map<string, string>(), status: 'not-requested' as const }

    const conversations = ownedSessions.map(session => {
        const engine = engineById.get(session.engineSessionId)
        const result = engine?.source === 'schedule' || engine?.source === 'trigger' ? engine.automationResult : undefined
        const pendingQuestion = labels.get(session.id) ?? null
        return {
            id: session.id,
            agentId: session.agentId,
            engineSessionId: session.engineSessionId,
            title: session.titleEdited ? session.title : result?.title ?? session.title,
            ...(result && { automationOutcome: result.outcome }),
            createdAt: session.createdAt,
            updatedAt: engine?.updatedAt ?? session.updatedAt,
            source: engine?.source ?? null,
            needsYou: pendingQuestion !== null,
            pendingQuestion,
            kind: session.kind ?? 'thread',
            firstMessage: session.firstMessage ?? null,
        } satisfies DesktopChatHistoryConversation
    }).sort((a, b) => updatedTime(b.updatedAt) - updatedTime(a.updatedAt) || updatedTime(b.createdAt) - updatedTime(a.createdAt) || a.id.localeCompare(b.id))

    // General has its own tab and never needs classification in the Threads filters.
    const missingThreadMetadata = ownedSessions.some(session => session.kind !== 'general' && !engineById.has(session.engineSessionId))
    return { conversations, enrichment: engineSessions === null || missingThreadMetadata ? 'unavailable' : 'ok', questions }
}
