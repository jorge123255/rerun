'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { DesktopQuickReplies } from '@/components/desktop/DesktopQuickReplies'
import { createQuickReplyAdapter, type InteractionDraftRecord } from '@/lib/desktop/chat-interactions/quick-replies'
import { interactionKey, sameInteraction, type ChatInteractionIdentity } from '@/lib/desktop/chat-interactions/identity'
import type { DesktopQuickReplyMessage, DesktopQuickReplySend } from '@/lib/desktop/quick-replies'
export type ScopedQuickRepliesProps = {
    identity: ChatInteractionIdentity; current(): ChatInteractionIdentity | null
    message: DesktopQuickReplyMessage & { id: string }; record(): InteractionDraftRecord | null
    onSend: DesktopQuickReplySend; onDraftChanged(record: InteractionDraftRecord): void; focusDraft?(): void
    show?: boolean; disabled?: boolean; pending?: boolean
}
export function ScopedQuickReplies(props: ScopedQuickRepliesProps) {
    return <ScopedReplies key={interactionKey(props.identity)} {...props} />
}
function ScopedReplies(props: ScopedQuickRepliesProps) {
    const latest = useRef(props); latest.current = props
    const [notice, setNotice] = useState(''), mounted = useRef(false)
    const adapter = useMemo(() => createQuickReplyAdapter(props.identity, {
        current: () => mounted.current ? latest.current.current() : null,
        message: () => latest.current.message, record: () => latest.current.record(), send: text => latest.current.onSend(text),
        onDraftChanged: record => latest.current.onDraftChanged(record), focusDraft: () => latest.current.focusDraft?.(),
    }), [])
    useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
    return <div className="min-w-0 space-y-1">
        <DesktopQuickReplies message={props.message} show={props.show} disabled={props.disabled} pending={props.pending} onSend={async text => {
            if (latest.current.show === false || latest.current.disabled || latest.current.pending) return false
            const outcome = await adapter.activate(text)
            if (mounted.current && sameInteraction(props.identity, latest.current.current())) setNotice(outcome.kind === 'blocked' ? outcome.reason : outcome.kind === 'draft' ? outcome.saved ? 'Complete the value in your draft before sending.' : 'The suggestion is in your draft. Retry saving it before sending.' : '')
            return outcome.kind === 'sent' && outcome.accepted
        }} />
        {notice && <p role="status" className="text-xs text-muted-foreground">{notice}</p>}
    </div>
}
