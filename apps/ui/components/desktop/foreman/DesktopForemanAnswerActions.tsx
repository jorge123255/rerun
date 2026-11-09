'use client'

import { MessageAction, MessageActions } from '@/components/ai-elements/message'
import { ThumbsDownIcon, ThumbsUpIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { MessageFeedbackRating } from '@rerun/contracts'

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

/** The original thumbs row, limited to a saved Foreman answer. No copy, regenerate or dialog;
 * the local feedback authority only records the rating. */
export function DesktopForemanAnswerActions({ rating, disabled, onRate }: {
    rating: MessageFeedbackRating | null
    disabled?: boolean
    onRate: (rating: MessageFeedbackRating) => void
}) {
    return <MessageActions className="mt-1" aria-label="Rate this answer">
        <FeedbackThumb rating="up" current={rating} disabled={disabled} onRate={onRate} />
        <FeedbackThumb rating="down" current={rating} disabled={disabled} onRate={onRate} />
    </MessageActions>
}
