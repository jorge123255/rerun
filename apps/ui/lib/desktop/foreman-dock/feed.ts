import type { DesktopForemanChatRef } from '@/lib/desktop/foreman-client/identity'
import { sameForemanChat } from '@/lib/desktop/foreman-client/identity'
import type { DesktopForemanClientState } from '@/lib/desktop/foreman-client/runtime-client'
import { visibleText } from '@rerun/contracts'
import type { ForemanNudge } from '@/lib/foreman/dock-feed'

export type ExactDockFeed = DesktopForemanChatRef & {
    source: 'current' | 'history'
    runId: string | null
    busy: boolean
    label: string | null
    pending: (ForemanNudge & { runId: string; requestId: string }) | null
    reply: { id: string; text: string; runId: string } | null
    failed: { runId: string } | null
}
export const emptyFeed = { busy: false, label: null, pending: null, reply: null, failed: null }
export function createParkedFeed(chat: DesktopForemanChatRef) {
    let witnessed: string | null = null
    const dismissed = new Set<string>()
    return {
        dismiss(id: string) { dismissed.add(id); if (dismissed.size > 128) dismissed.delete(dismissed.values().next().value!) },
        accept(feed: ExactDockFeed | null, open: boolean) {
            if (!feed || !sameForemanChat(chat, feed) || feed.source !== 'current') { witnessed = null; return emptyFeed }
            if (open) { witnessed = null; return emptyFeed }
            if (feed.busy && feed.runId) witnessed = feed.runId
            const pending = !feed.busy && feed.pending && feed.pending.runId === feed.runId && !dismissed.has(feed.pending.id) ? feed.pending : null
            const reply = !feed.busy && !pending && feed.reply?.runId === feed.runId && feed.reply?.runId === witnessed && !dismissed.has(feed.reply.id) ? feed.reply : null
            const failed = !feed.busy && feed.failed?.runId === feed.runId && feed.failed?.runId === witnessed && !dismissed.has(`failed:${witnessed}`) ? feed.failed : null
            return { busy: !!feed.runId && feed.busy, label: feed.busy ? feed.label : null, pending, reply, failed }
        },
    }
}

/** Canonical state projection, following the original closed-run observer semantics. */
export function createClientDockFeed(chat: DesktopForemanChatRef) {
    let observedRun: string | null = null
    let wasBusy = false
    let previousSignature: string | null = null
    let baseline: string | null = null
    let completedReply: ExactDockFeed['reply'] = null
    return (state: DesktopForemanClientState): ExactDockFeed | null => {
        if (!sameForemanChat(chat, state.chat) || !sameForemanChat(chat, state.view.chat)) {
            observedRun = null; wasBusy = false; previousSignature = null; completedReply = null
            return null
        }
        const runId = state.view.live?.runId ?? null
        const last = state.messages.at(-1)
        const text = last?.role === 'assistant' ? visibleText(last.parts, '\n').replace(/^#{1,6}\s+/gm, '').replace(/\*\*|__|`/g, '').trim().slice(0, 4096) : ''
        const signature = last ? JSON.stringify([last.id, last.role, text]) : null
        if (runId && runId !== observedRun) {
            observedRun = runId; baseline = previousSignature ?? signature; completedReply = null
        }
        if (!runId && wasBusy && observedRun && last?.role === 'assistant' && text && signature !== baseline) {
            completedReply = { id: last.id, text, runId: observedRun }
        }
        wasBusy = !!runId; previousSignature = signature
        return { ...chat, source: observedRun ? 'current' : 'history', runId: runId ?? observedRun, busy: !!runId, label: null, pending: null, reply: runId ? null : completedReply, failed: null }
    }
}
