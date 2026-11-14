'use client'

import { useDesktopLocale } from '../../DesktopLocale'

import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Orb, PARKED_ORB_SIZE, PARKED_ORB_SIZE_MOBILE, type OrbActivity } from '@rerun/ui/foreman'
import { ForemanReplyBubble } from '@/components/foreman/dock/ForemanReplyBubble'
import { ForemanNudge } from '@/components/foreman/dock/ForemanNudge'
import { ForemanPill } from '@/components/foreman/dock/ForemanPill'
import { ForemanPillTicker } from '@/components/foreman/dock/ForemanPillTicker'
import { TooltipLabeled } from '@/components/ui/tooltip'
import { resolveCorner, type ForemanCorner } from '@/lib/foreman-layout'
import type { DesktopForemanChatRef } from '@/lib/desktop/foreman-client/identity'
import { createParkedFeed, type ExactDockFeed } from '@/lib/desktop/foreman-dock/feed'
import { cn } from '@/lib/utils'

const CORNERS: Record<ForemanCorner, string> = {
    'top-left': 'top-[calc(var(--chrome-edge,12px)+var(--chrome-size,40px)+var(--chrome-gap,8px)+var(--board-inset,0px))] left-[calc(var(--chrome-edge,12px)+var(--board-inset,0px))]',
    'top-right': 'top-[calc(var(--chrome-edge,12px)-var(--orb-overhang)+var(--board-inset,0px))] right-[calc(var(--chrome-edge,12px)+var(--chrome-size,40px)+var(--chrome-gap,8px)+var(--board-inset,0px))]',
    'bottom-left': 'bottom-[calc(var(--chrome-edge,12px)-var(--orb-overhang)+var(--board-inset,0px)+var(--consent-inset,0px))] left-[calc(var(--desktop-board-edge,12px)+var(--board-corner-width,var(--chrome-size,40px))+var(--chrome-gap,8px))]',
    'bottom-right': 'bottom-[calc(var(--chrome-edge,12px)-var(--orb-overhang)+var(--board-inset,0px)+var(--consent-inset,0px))] right-[calc(var(--chrome-edge,12px)+var(--board-inset,0px))]',
}
export type DesktopParkedForemanProps = {
    chat: DesktopForemanChatRef; open: boolean; hidden?: boolean; centerOpen?: boolean; mobile: boolean; wide: boolean
    corner: ForemanCorner; onCorner: (corner: ForemanCorner) => void; onOpen: () => void
    activity?: OrbActivity; feed: ExactDockFeed | null
    /** F/root supplies its explicit view. This component never starts/stops a microphone. */
    voiceSlot?: ReactNode
    /** Root's accepted composer; no independent draft or send authority. */
    composerSlot?: ReactNode
    onTrigger: (node: HTMLElement | null) => void
}
export function DesktopParkedForeman(props: DesktopParkedForemanProps) {
    const { t } = useDesktopLocale()
    const reduce = useReducedMotion()
    const scope = `${props.chat.workspaceId}\u0000${props.chat.chatId}`
    const tracker = useMemo(() => createParkedFeed(props.chat), [scope])
    const [, rerender] = useState(0)
    const [dragging, setDragging] = useState(false)
    const dragged = useRef(false)
    const cancelledDrag = useRef(false)
    const [dragEpoch, setDragEpoch] = useState(0)
    const wrap = useRef<HTMLDivElement>(null)
    const pill = useRef<HTMLDivElement>(null)
    const feed = tracker.accept(props.feed, props.open)
    const visible = !props.open && !props.hidden
    const pillVisible = visible && props.wide && !props.centerOpen && !dragging
    useEffect(() => {
        if (!dragging) return
        const cancel = () => { cancelledDrag.current = true; dragged.current = true; setDragging(false); setDragEpoch(x => x + 1) }
        const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); cancel() } }
        window.addEventListener('blur', cancel); window.addEventListener('resize', cancel); document.addEventListener('visibilitychange', cancel); window.addEventListener('keydown', key, true)
        return () => { window.removeEventListener('blur', cancel); window.removeEventListener('resize', cancel); document.removeEventListener('visibilitychange', cancel); window.removeEventListener('keydown', key, true) }
    }, [dragging])
    const size = props.mobile ? PARKED_ORB_SIZE_MOBILE : PARKED_ORB_SIZE
    const showPill = pillVisible && !!(feed.busy || props.voiceSlot || props.composerSlot)
    useLayoutEffect(() => {
        const frame = wrap.current?.closest<HTMLElement>('[data-desktop-board-frame]')
        if (!frame || !visible || !props.corner.startsWith('bottom')) return
        const property = props.corner === 'bottom-left' ? '--desktop-left-orb-width' : '--desktop-right-orb-width'
        const surface = pill.current
        const measure = () => frame.style.setProperty(property, `${Math.max(size, surface?.offsetWidth ?? 0) + 8}px`)
        measure()
        const observer = new ResizeObserver(measure)
        if (surface) observer.observe(surface)
        return () => {
            observer.disconnect()
            frame.style.removeProperty(property)
        }
    }, [visible, props.corner, showPill, size])
    useEffect(() => { dragged.current = false; setDragging(false) }, [scope, props.hidden, props.open])
    const dismiss = (id: string) => { tracker.dismiss(id); rerender(x => x + 1) }
    return <div ref={wrap} data-foreman-orb hidden={!!props.hidden} inert={!visible} style={{ width: size, height: size, '--orb-overhang': `${(size - 40) / 2}px`, maxWidth: 'calc(100vw - 24px)' } as CSSProperties} className={cn('pointer-events-none fixed z-40', CORNERS[props.corner])}>
        {showPill && <ForemanPill ref={pill} side={props.corner.endsWith('left') ? 'left' : 'right'} width={feed.busy ? 'w-[420px]' : 'w-[340px]'} tone={feed.pending ? 'orange' : feed.failed ? 'red' : undefined}>
            {props.voiceSlot ?? (feed.busy ? <ForemanPillTicker label={feed.label} /> : props.composerSlot)}
        </ForemanPill>}
        <motion.div key={`${scope}:${dragEpoch}:${visible}`} drag={visible} dragMomentum={false} dragSnapToOrigin dragTransition={{ bounceStiffness: reduce ? 100000 : 500, bounceDamping: reduce ? 1000 : 38 }}
            onPointerDownCapture={() => { dragged.current = false }} onDragStart={() => { cancelledDrag.current = false; dragged.current = true; setDragging(true) }}
            onDragEnd={(event, info) => {
                setDragging(false)
                if (cancelledDrag.current || !visible || props.hidden || document.hidden || event.type === 'pointercancel') return
                props.onCorner(resolveCorner({ x: info.point.x - window.scrollX, y: info.point.y - window.scrollY }, { width: window.innerWidth, height: window.innerHeight }))
            }}
            animate={{ opacity: visible ? 1 : 0, scale: visible ? 1 : 0.7 }} transition={{ duration: reduce ? 0 : 0.22 }} className={cn('relative touch-none', visible && 'pointer-events-auto')}>
            <TooltipLabeled side={props.corner.startsWith('bottom') ? 'top' : 'bottom'} hidden={!visible} label={t('foreman.ask')}><span ref={node => props.onTrigger(node?.querySelector<HTMLElement>('button') ?? node)} className="block">
                <Orb size={size} state={props.activity ?? (feed.busy ? 'thinking' : 'idle')} paused={!visible} facing={props.corner.endsWith('left') ? 'right' : 'left'} label={t('foreman.ask')} onClick={() => { if (!dragged.current && visible) props.onOpen(); dragged.current = false }} />
            </span></TooltipLabeled>
        </motion.div>
        <div className="contents [&>div]:max-w-[calc(100vw-24px)] [&>div]:max-h-[max(48px,calc(100dvh-120px))] [&>div]:overflow-y-auto"><AnimatePresence>{pillVisible && feed.pending ? <ForemanNudge key={feed.pending.id} corner={props.corner} nudge={feed.pending} onOpen={props.onOpen} onLater={() => dismiss(feed.pending!.id)} />
            : pillVisible && feed.reply ? <ForemanReplyBubble key={feed.reply.id} corner={props.corner} text={feed.reply.text} onOpen={props.onOpen} onDismiss={() => dismiss(feed.reply!.id)} />
            : pillVisible && feed.failed ? <ForemanReplyBubble key={`failed:${feed.failed.runId}`} corner={props.corner} text={t('foreman.failedReply')} failed onOpen={props.onOpen} onDismiss={() => dismiss(`failed:${feed.failed!.runId}`)} /> : null}</AnimatePresence></div>
    </div>
}
