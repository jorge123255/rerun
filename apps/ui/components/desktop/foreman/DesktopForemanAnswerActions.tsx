'use client'

import { MessageAction, MessageActions } from '@/components/ai-elements/message'
import { CheckIcon, CopyIcon, RotateCwIcon, ThumbsDownIcon, ThumbsUpIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { MessageFeedbackRating } from '@rerun/contracts'
import { useDesktopLocale } from '../DesktopLocale'
import { copyDesktopPlainText } from '@/lib/desktop/clipboard'
import { useCopy } from '@/lib/use-copy'
import { toast } from 'sonner'
import type { ReactNode } from 'react'

function FeedbackThumb({ rating, current, disabled, onRate }: {
    rating: MessageFeedbackRating
    current: MessageFeedbackRating | null
    disabled?: boolean
    onRate: (rating: MessageFeedbackRating) => void
}) {
    const { t } = useDesktopLocale()
    const pressed = current === rating
    const Glyph = rating === 'up' ? ThumbsUpIcon : ThumbsDownIcon
    return (
        <MessageAction
            tooltip={t(rating === 'up' ? 'replyActions.goodResponse' : 'replyActions.badResponse')}
            aria-pressed={pressed}
            disabled={disabled}
            className={cn(pressed ? 'bg-accent text-foreground' : 'text-muted-foreground')}
            onClick={() => onRate(rating)}
        >
            <Glyph className="size-3.5" />
        </MessageAction>
    )
}

export function DesktopForemanAnswerActions({ copyText, rating = null, disabled, onRate, onReviewRetry, retryDisabled, readAloud }: {
    copyText?: string
    rating?: MessageFeedbackRating | null
    disabled?: boolean
    onRate?: (rating: MessageFeedbackRating) => void
    onReviewRetry?: () => void
    retryDisabled?: boolean
    /** The "Read aloud" action, present only when an ElevenLabs key is saved. */
    readAloud?: ReactNode
}) {
    const { t } = useDesktopLocale()
    const { copied, copy } = useCopy(() => toast.error(t('copyReplyFailed')), copyDesktopPlainText)
    const copyLabel = t(copied ? 'foreman.copied' : 'foreman.copy')
    if (!copyText && !onRate && !onReviewRetry && !readAloud) return null
    return <MessageActions className="mt-1 flex-wrap" data-chat-find-ignore>
        {copyText && <MessageAction tooltip={copyLabel} aria-label={copyLabel} onClick={() => copy(copyText)}>
            {copied ? <CheckIcon aria-hidden className="size-3.5" /> : <CopyIcon aria-hidden className="size-3.5" />}
        </MessageAction>}
        {onReviewRetry && <MessageAction tooltip={t('foreman.alternates.regenerate')} label={t('foreman.alternates.regenerate')}
            disabled={disabled || retryDisabled} onClick={onReviewRetry}>
            <RotateCwIcon className="size-3.5" />
        </MessageAction>}
        {readAloud}
        {onRate && <>
            <FeedbackThumb rating="up" current={rating} disabled={disabled} onRate={onRate} />
            <FeedbackThumb rating="down" current={rating} disabled={disabled} onRate={onRate} />
        </>}
    </MessageActions>
}
