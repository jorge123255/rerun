import { quickReplyDraft, quickRepliesOf } from '../../../../../packages/contracts/src/chat-quick-replies'
import { desktopAttachmentSelectionsOf } from '@rerun/contracts'
import { isDesktopQuitting, saveDesktopDraft, updateDesktopDraft, type desktopDraftRecord } from '../draft-writes'
import type { DesktopQuickReplyMessage, DesktopQuickReplySend } from '../quick-replies'
import { sameInteraction, type ChatInteractionIdentity } from './identity'
export type InteractionDraftRecord = ReturnType<typeof desktopDraftRecord>
export type QuickReplyOutcome = { kind: 'sent'; accepted: boolean } | { kind: 'draft'; saved: boolean } | { kind: 'blocked'; reason: string }

export function createQuickReplyAdapter(identity: ChatInteractionIdentity, ports: {
    current(): ChatInteractionIdentity | null; message(): DesktopQuickReplyMessage & { id: string }
    record(): InteractionDraftRecord | null; send: DesktopQuickReplySend
    onDraftChanged(record: InteractionDraftRecord): void; focusDraft?(): void
}) {
    let closed = false, busy = false
    const current = () => !closed && !isDesktopQuitting() && sameInteraction(identity, ports.current())
    return {
        async activate(text: string): Promise<QuickReplyOutcome> {
            const message = ports.message()
            if (busy || !current() || message.id !== identity.messageId || !quickRepliesOf(message).includes(text)) return { kind: 'blocked', reason: 'This suggestion is no longer current.' }
            busy = true
            try {
                const draftText = quickReplyDraft(text)
                if (draftText === null) {
                    const accepted = await ports.send(text)
                    return current() ? { kind: 'sent', accepted: accepted === true } : { kind: 'blocked', reason: 'The original chat is no longer active. Its accepted receipt is preserved.' }
                }
                const record = ports.record()
                if (!record || record.agentId !== identity.agentId || record.uid !== identity.tabUid || record.forgotten || !record.state.loaded || record.state.saving || record.state.error || record.state.conflict || record.attempt) return { kind: 'blocked', reason: 'Load or recover this chat draft before using the suggestion.' }
                if (record.dirty || record.state.text.length || desktopAttachmentSelectionsOf(record.state).length || record.state.coworkerMentions?.length) return { kind: 'blocked', reason: 'Your current draft was kept. Finish or clear it before inserting this suggestion.' }
                if (!current()) return { kind: 'blocked', reason: 'This suggestion is no longer current.' }
                updateDesktopDraft(record, { text: draftText })
                const version = record.state.version
                ports.onDraftChanged(record)
                await saveDesktopDraft(record)
                if (!current() || ports.record() !== record) return { kind: 'blocked', reason: 'The original chat changed; its draft was preserved.' }
                const saved = !record.state.error && !record.state.conflict && !record.dirty
                if (record.state.version === version && record.state.text === draftText) ports.focusDraft?.()
                return { kind: 'draft', saved }
            } finally { busy = false }
        },
        close() { closed = true },
    }
}
