import { useLayoutEffect, useRef, type RefObject } from 'react'

import type { ConversationHandle } from '@/components/ai-elements/conversation'

const TOP_GAP = 12

export type Arrival = 'measure-later' | 'stick' | 'arrive'

// A chat kept mounted behind another tab, another coworker or a closed panel is `display: none`:
// its block and its thread both measure 0. Reading that as "taller than the thread" used to unstick
// the conversation and park it at the very top, where the user found it on coming back.
export function arrivalOf(blockHeight: number, threadHeight: number): Arrival {
    if (blockHeight === 0 || threadHeight === 0) return 'measure-later'
    return blockHeight + TOP_GAP <= threadHeight ? 'stick' : 'arrive'
}

// A block at the end that fits follows the bottom by default. Explicit navigation can target its top.
export function bringBlockIn(conversation: ConversationHandle, blockEl: HTMLElement, behavior: ScrollBehavior, align: 'auto' | 'start' = 'auto') {
    const scrollEl = conversation.scrollRef.current
    if (!scrollEl) return
    if (align === 'auto' && arrivalOf(blockEl.offsetHeight, scrollEl.clientHeight) !== 'arrive') {
        void conversation.scrollToBottom(behavior)
        return
    }
    conversation.stopScroll()
    scrollEl.scrollTo({ top: scrollEl.scrollTop + blockEl.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top - TOP_GAP, behavior })
}

// Sticking to the bottom shows the buttons of a block taller than the thread and hides what it
// asks. Bring a tall block in by its top once per request and explicit arrival. Keep watching
// blocks that fit in case they grow, and leave the user's scrolling alone after positioning.
export function useArriveByTop(conversationRef: RefObject<ConversationHandle | null>, key: string | null, arrival?: object | null, active = true) {
    const blockRef = useRef<HTMLDivElement | null>(null)
    const positioned = useRef<{ key: string; arrival: typeof arrival } | null>(null)

    useLayoutEffect(() => {
        if (!active) return
        if (positioned.current?.key === key && positioned.current.arrival === arrival) return
        positioned.current = null
        const blockEl = blockRef.current
        if (key === null || !blockEl) return
        let frame = 0
        const observer = new ResizeObserver(() => {
            const conversation = conversationRef.current
            const scrollEl = conversation?.scrollRef.current
            if (!conversation || !scrollEl) return
            if (arrivalOf(blockEl.offsetHeight, scrollEl.clientHeight) !== 'arrive') return
            observer.disconnect()
            frame = requestAnimationFrame(() => {
                bringBlockIn(conversation, blockEl, 'instant')
                positioned.current = { key, arrival }
            })
        })
        observer.observe(blockEl)
        return () => {
            observer.disconnect()
            cancelAnimationFrame(frame)
        }
    }, [conversationRef, key, arrival, active])

    return blockRef
}
