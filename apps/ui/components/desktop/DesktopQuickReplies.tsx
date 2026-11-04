'use client'

import { useEffect, useRef, useState } from 'react'
import { Suggestion, Suggestions } from '@/components/ai-elements/suggestion'
import { desktopQuickRepliesOf, type DesktopQuickReplyMessage } from '@/lib/desktop/quick-replies'

export function DesktopQuickReplies({ message, show = true, disabled = false, pending = false, onSend }: {
    message: DesktopQuickReplyMessage
    show?: boolean
    disabled?: boolean
    pending?: boolean
    onSend: (text: string) => void | Promise<void>
}) {
    const [activated, setActivated] = useState(false)
    const activating = useRef(false)
    const messageId = 'id' in message ? message.id : undefined
    useEffect(() => {
        activating.current = false
        setActivated(false)
    }, [messageId])

    if (!show) return null
    const replies = desktopQuickRepliesOf(message)
    if (replies.length === 0) return null
    const blocked = disabled || pending || activated

    const activate = (text: string) => {
        if (blocked || activating.current) return
        activating.current = true
        setActivated(true)
        try {
            const result = onSend(text)
            if (result && typeof result.then === 'function') {
                void result.catch(() => {
                    activating.current = false
                    setActivated(false)
                })
            }
        } catch (error) {
            activating.current = false
            setActivated(false)
            throw error
        }
    }

    return <Suggestions className="animate-in fade-in duration-300">
        {replies.map(reply => <Suggestion key={reply} suggestion={reply} disabled={blocked} onClick={activate} />)}
    </Suggestions>
}
