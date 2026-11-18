import { stripBridgePrefix } from '@rerun/contracts'
import { ownerSetupLink } from '../foreman/owner-setup-link'
import type { DesktopForemanRevision, DesktopTeamChanges, MacPhoneChiefCard, MacPhoneChiefSetupTarget } from '@rerun/contracts'

// The Chief of Staff as a paired phone reads it: its conversations, the text of their messages, the
// question one waits on, and the plain words of the cards that change things. Those cards (a plan to
// build, team changes, a starter pack) are only ever settled on the Mac: the phone is handed their
// words and read-only setup shortcuts. Team-change approvals remain on the Mac.

export type PhoneChiefCard = MacPhoneChiefCard

export type PhoneChiefConversation = { id: string; title: string | null; kind: 'general' | 'thread'; createdAt: string; updatedAt: string }

const LINES = 40
const words = (value: string, limit = 280) => value.replace(/\s+/g, ' ').trim().slice(0, limit)

// The conversations someone wrote in. One nobody wrote in yet has no date and nothing to read.
export function phoneChiefConversations(saved: readonly { chat: { chatId: string }; title: string | null; home: boolean; updatedAt?: string; startedAt?: string }[]): PhoneChiefConversation[] {
    return saved.flatMap(item => item.updatedAt ? [{
        id: item.chat.chatId, title: item.title, kind: item.home ? 'general' as const : 'thread' as const,
        createdAt: item.startedAt ?? item.updatedAt, updatedAt: item.updatedAt,
    }] : [])
}

// The Mac's own rule for showing its first-run company questions instead of the conversation: General
// only, until they are finished, when nothing was said yet or some answers were already saved.
export function phoneChiefInIntake(input: { finished: boolean; savedProgress: boolean; messageCount: number }): boolean {
    return !input.finished && (input.messageCount === 0 || input.savedProgress)
}

// Only the words and the destinations of completed, public Chief setup inspections go to a phone.
export function phoneChiefMessages(messages: readonly { id: string; role: 'user' | 'assistant'; parts: readonly unknown[]; metadata?: { createdAt?: string } }[]) {
    return messages.flatMap(message => {
        const text = message.parts.flatMap(part => {
            const { type, text } = (part && typeof part === 'object' ? part : {}) as { type?: unknown; text?: unknown }
            return type === 'text' && typeof text === 'string' ? [text] : []
        }).join('\n')
        const ownerSetups = message.role === 'assistant' ? message.parts.flatMap(raw => {
            const part = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
            if (part.desktopPreview !== true || part.state !== 'output-available' || typeof part.toolName !== 'string'
                || stripBridgePrefix(part.toolName) !== 'inspect_coworker_setup') return []
            const link = ownerSetupLink(part.output)
            return link ? [{ agentId: link.agentId, coworker: link.coworker, sessionId: link.ownerSessionId }] : []
        }).slice(0, LINES) : []
        return text || ownerSetups.length ? [{ id: message.id, role: message.role, ...(ownerSetups.length > 0 && { ownerSetups }), ...(message.metadata?.createdAt && { createdAt: message.metadata.createdAt }), content: { type: 'text' as const, text } }] : []
    })
}

type Starter = { cards: readonly { title: string }[]; decision: { settled: boolean } | null } | null | undefined

// The cards still waiting to be settled, in words: the plan as last shown, the latest team changes,
// the starter pack. One that was confirmed, applied, dismissed or replaced is no longer a card.
export function phoneChiefCards(input: {
    revisions: readonly Pick<DesktopForemanRevision, 'revisionId' | 'state' | 'plan'>[]
    currentRevisionId: string | null
    teamChanges: Pick<DesktopTeamChanges, 'summary' | 'state' | 'changes'> | null
    starter: Starter
    messageCount: number
}): PhoneChiefCard[] {
    const cards: PhoneChiefCard[] = []
    const waitingStarter = Boolean(input.starter && !input.starter.decision?.settled)
    if (input.starter && waitingStarter) cards.push({ kind: 'starter', title: '', lines: input.starter.cards.slice(0, LINES).map(card => words(card.title)) })
    const revision = input.revisions.find(item => item.revisionId === input.currentRevisionId)
    if (revision?.state === 'shown') {
        cards.push({ kind: 'plan', title: words(revision.plan.title), lines: revision.plan.items.slice(0, LINES).map(item => item.kind === 'agent'
            ? words(`${item.name}: ${item.role}`)
            : words([item.title || item.templateId, item.focus].filter(Boolean).join(': '))) })
    }
    // The Mac holds this card back until the starter pack is settled and something was said.
    if (input.teamChanges?.state === 'shown' && !waitingStarter && input.messageCount > 0) {
        const changes = input.teamChanges.changes.slice(0, LINES)
        const setupTargets: MacPhoneChiefSetupTarget[] = []
        for (const change of changes) {
            if (!change.agentId || !change.coworker) continue
            if (change.action === 'start_setup') setupTargets.push({ agentId: change.agentId, coworker: change.coworker, sessionId: null })
            if (change.action === 'reply_setup' && change.setupReply) {
                const { sessionId, text, question } = change.setupReply
                setupTargets.push({ agentId: change.agentId, coworker: change.coworker, sessionId, reply: text, ...(question && { question }) })
            }
        }
        cards.push({
            kind: 'team-changes', title: words(input.teamChanges.summary),
            lines: changes.map(change => words([change.label, change.caution].filter(Boolean).join(' — '), 600)),
            ...(setupTargets.length > 0 && { setupTargets }),
        })
    }
    return cards
}
