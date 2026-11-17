'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { AttentionBuddy } from '@rerun/ui/inbox'
import { useScrollFade } from '@rerun/ui/primitives'
import { shortRelativeTime } from '@rerun/i18n/format'
import { CUE_MOTION, PendingHitlPill } from '@/components/chat/PendingHitlPill'
import { usePeekTranslations } from '@/components/notifications/peek-translations'
import { Button } from '@/components/ui/button'
import { usePendingInView } from '@/hooks/usePendingInView'
import { summarizePendingHitl } from '@/lib/chat/hitl-cue'
import { desktopLocaleTag } from '@/lib/desktop/locale'
import { ArrowLeftIcon, ArrowRight, XIcon } from '@/lib/icons'
import { useDesktopLocale } from './DesktopLocale'
import { DesktopPeekBody } from './DesktopPeekBody'
import { useDesktopInboxPeek, useDesktopPeekAnswer } from './useDesktopInboxPeek'

// Room left around the request once the pill has scrolled it in.
const JUMP_GAP = 12

export type DesktopInboxPeekEntry = { id: string; agentId: string; agentName: string; agentEnabled: boolean; sessionId: string; status: string; title: string; updatedAt: string }

/**
 * A coworker's question or approval, read and answered from the Actions inbox without opening the
 * conversation (upstream #273, #274, #288, `InboxPeekCard`). Opening it reads only: it marks nothing
 * read and answers nothing. The back arrow returns to the list, the footer opens the conversation,
 * and a pill leads to the request when the words above it have pushed it out of view.
 */
export function DesktopInboxPeekCard({ entry, waiting, onBack, onClose, onAnswered, onOpenConversation }: {
    entry: DesktopInboxPeekEntry
    /** The entry is still in the list of what needs the person. */
    waiting: boolean
    onBack: () => void
    onClose: () => void
    /** The receipt has shown: the card goes away, as upstream's does. */
    onAnswered: () => void
    onOpenConversation: () => void
}) {
    const { language, t: desktop } = useDesktopLocale()
    const t = usePeekTranslations()
    const reducedMotion = useReducedMotion()
    const { peek, answer } = useDesktopInboxPeek(entry.sessionId)
    const { phase, notice, attempt, submit } = useDesktopPeekAnswer(peek, answer, onAnswered)
    const [bodyEl, setBodyEl] = useState<HTMLDivElement | null>(null)
    const bodyRef = useRef<HTMLDivElement | null>(null)
    const setBody = useCallback((element: HTMLDivElement | null) => { bodyRef.current = element; setBodyEl(element) }, [])
    const widgetRef = useRef<HTMLDivElement>(null)
    const mask = useScrollFade(bodyEl)

    const sent = phase.step === 'sent'
    const pending = peek.state === 'ready' ? peek.peek.pending : null
    const asking = pending && phase.step === 'asking' ? pending : null
    const widgetVisibility = usePendingInView(bodyRef, widgetRef, asking?.toolCallId ?? null)
    const cue = useMemo(() => {
        if (!asking) return null
        const count = asking.kind === 'question' ? (asking.input.questions as unknown[]).length : (asking.input.approvals as unknown[]).length
        return summarizePendingHitl(asking.kind, asking.input, desktop(asking.kind === 'question' ? 'chatRequestCue.question' : 'chatRequestCue.approval', { count }))
    }, [asking, desktop])
    const subtitle = [entry.title, shortRelativeTime(entry.updatedAt, desktopLocaleTag(language.locale))].filter(Boolean).join(' · ')

    // Scrolls just enough to show the whole request, its top first when it is taller than the card.
    const jumpToWidget = () => {
        const body = bodyRef.current, widget = widgetRef.current
        if (!body || !widget) return
        const bodyRect = body.getBoundingClientRect(), widgetRect = widget.getBoundingClientRect()
        const bottomIn = widgetRect.bottom - bodyRect.bottom + JUMP_GAP
        const topIn = widgetRect.top - bodyRect.top - JUMP_GAP
        body.scrollTo({ top: body.scrollTop + Math.min(bottomIn, topIn), behavior: reducedMotion ? 'auto' : 'smooth' })
    }

    return (
        <div data-actions-inbox-peek={entry.id} className="flex max-h-[min(36rem,calc(100dvh-8rem))] flex-col">
            <div className="flex shrink-0 items-start gap-2.5 p-3 pb-2">
                <Button size="icon-sm" variant="ghost" aria-label={t('back')} title={t('back')} onClick={onBack}>
                    <ArrowLeftIcon className="size-3.5" />
                </Button>
                <AttentionBuddy agentId={entry.agentId} status={sent ? 'done' : entry.status} />
                <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium text-foreground">{entry.agentName}</span>
                    {subtitle && <span className="truncate text-xs text-muted-foreground">{subtitle}</span>}
                </div>
                <Button size="icon-sm" variant="ghost" aria-label={t('close')} title={t('close')} onClick={onClose}>
                    <XIcon className="size-3.5" />
                </Button>
            </div>

            <div className="relative flex min-h-0 flex-1 flex-col">
                <div ref={setBody} style={{ maskImage: mask, WebkitMaskImage: mask }} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-3">
                    <DesktopPeekBody peek={peek} waiting={waiting} phase={phase} notice={notice} attempt={attempt} agentId={entry.agentId} agentName={entry.agentName}
                        disabled={!entry.agentEnabled} widgetRef={widgetRef} className="flex flex-col gap-3" onSubmit={submit} onDismiss={onBack} />
                </div>
                <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center px-3">
                    <AnimatePresence initial={false}>
                        {cue && widgetVisibility === 'out-of-view' && (
                            <motion.div key="pending" {...CUE_MOTION} className="pointer-events-auto flex max-w-full justify-center">
                                <PendingHitlPill summary={cue} onJump={jumpToWidget} />
                            </motion.div>
                        )}
                    </AnimatePresence>
                </div>
            </div>

            <div className="flex shrink-0 justify-end border-t border-border px-3 py-2">
                <Button size="sm" variant="ghost" onClick={onOpenConversation}>
                    {t('openConversation')}
                    <ArrowRight className="size-3.5" />
                </Button>
            </div>
        </div>
    )
}
