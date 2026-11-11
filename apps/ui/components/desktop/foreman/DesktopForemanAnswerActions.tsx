'use client'

import { MessageAction, MessageActions } from '@/components/ai-elements/message'
import { RotateCwIcon, ThumbsDownIcon, ThumbsUpIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { MessageFeedbackRating } from '@rerun/contracts'
import { useDesktopLocale } from '../DesktopLocale'

function FeedbackThumb({ rating, current, disabled, onRate }: {
    rating: MessageFeedbackRating
    current: MessageFeedbackRating | null
    disabled?: boolean
    onRate: (rating: MessageFeedbackRating) => void
}) {
    const pressed = current === rating
    const Glyph = rating === 'up' ? ThumbsUpIcon : ThumbsDownIcon
    return (
        <MessageAction
            tooltip={rating === 'up' ? 'Good response' : 'Bad response'}
            label={rating === 'up' ? 'Good response' : 'Bad response'}
            aria-pressed={pressed}
            disabled={disabled}
            className={cn(pressed ? 'bg-accent text-foreground' : 'text-muted-foreground')}
            onClick={() => onRate(rating)}
        >
            <Glyph className="size-3.5" />
        </MessageAction>
    )
}

export function DesktopForemanAnswerActions({ rating, disabled, onRate, onReviewRetry, retryDisabled }: {
    rating: MessageFeedbackRating | null
    disabled?: boolean
    onRate: (rating: MessageFeedbackRating) => void
    onReviewRetry?: () => void
    retryDisabled?: boolean
}) {
    const { t } = useDesktopLocale()
    return <MessageActions className="mt-1" aria-label="Rate this answer">
        {onReviewRetry && <MessageAction tooltip={t('foreman.alternates.regenerate')} label={t('foreman.alternates.regenerate')}
            disabled={disabled || retryDisabled} onClick={onReviewRetry}>
            <RotateCwIcon className="size-3.5" />
        </MessageAction>}
        <FeedbackThumb rating="up" current={rating} disabled={disabled} onRate={onRate} />
        <FeedbackThumb rating="down" current={rating} disabled={disabled} onRate={onRate} />
    </MessageActions>
}
