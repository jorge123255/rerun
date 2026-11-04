'use client'

import { useEffect, useRef, useState } from 'react'
import { Suggestion, Suggestions } from '@/components/ai-elements/suggestion'
import { desktopQuickRepliesOf, type DesktopQuickReplyMessage, type DesktopQuickReplySend } from '@/lib/desktop/quick-replies'

type QuickReplyActivation = { messageId: unknown; generation: number }

export function DesktopQuickReplies({ message, show = true, disabled = false, pending = false, onSend }: {
    message: DesktopQuickReplyMessage
    show?: boolean
    disabled?: boolean
    pending?: boolean
    onSend: DesktopQuickReplySend
}) {
    const messageId = 'id' in message ? message.id : undefined
    const [latched, setLatched] = useState<QuickReplyActivation | null>(null)
    const activating = useRef<QuickReplyActivation | null>(null)
    const generation = useRef(0)
    useEffect(() => {
        activating.current = null
        setLatched(null)
    }, [messageId])

    if (!show) return null
    const replies = desktopQuickRepliesOf(message)
    if (replies.length === 0) return null
    const activated = latched !== null && latched.messageId === messageId
    const blocked = disabled || pending || activated

    const activate = (text: string) => {
        if (activating.current && activating.current.messageId !== messageId) activating.current = null
        if (blocked || activating.current) return
        const activation: QuickReplyActivation = { messageId, generation: ++generation.current }
        activating.current = activation
        setLatched(activation)
        const settle = (accepted: boolean) => {
            if (activating.current !== activation) return
            activating.current = null
            if (accepted !== true) setLatched(current => current === activation ? null : current)
        }
        try {
            void Promise.resolve(onSend(text)).then(settle, () => settle(false))
        } catch {
            settle(false)
        }
    }

    return <Suggestions className="animate-in fade-in duration-300">
        {replies.map(reply => <Suggestion key={reply} suggestion={reply} disabled={blocked} onClick={activate} />)}
    </Suggestions>
}
