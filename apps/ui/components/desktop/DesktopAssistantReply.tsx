'use client'

import type { UIMessage } from 'ai'
import { useMemo, type ReactNode } from 'react'
import type { Components, CustomRendererProps, PluginConfig } from 'streamdown'
import { toast } from 'sonner'
import { MessageAction, MessageResponse } from '@/components/ai-elements/message'
import { DRAFT_LANGUAGE, DraftBlock } from '@/components/chat/DraftBlock'
import { AGENT_BUBBLE_SURFACE } from '@/components/chat/bubble-styles'
import { ReasoningStep } from '@/components/chat/ReasoningBlock'
import { Button } from '@/components/ui/button'
import type { MessageFeedbackRating } from '@rerun/contracts'
import { CheckIcon, CopyIcon, RefreshCcwIcon, ThumbsDownIcon, ThumbsUpIcon } from '@/lib/icons'
import { isDesktopSummaryMetadata } from '@/lib/desktop/reasoning-summary'
import { useCopy } from '@/lib/use-copy'
import { splitIntoBubbles } from '@/lib/chat/message-bubbles'
import { cn } from '@/lib/utils'

const desktopComponents: Components = {
    a: ({ href, children }) => {
        // Links on the Mac open through the shell's HTTPS-only external navigation policy.
        const url = href && URL.canParse(href) ? new URL(href) : null
        return url?.protocol === 'https:' && !url.username && !url.password
            ? <a data-streamdown="link" href={url.href} target="_blank" rel="noopener noreferrer">{children}</a>
            : <span>{children}</span>
    },
    img: ({ alt }) => <span>{alt || 'Image'}</span>,
}

const noPlugins = {}
const noRehypePlugins: [] = []
const copyFailed = () => toast.error('Could not copy this reply. Try again.')
const draftCopyFailed = () => toast.error('Could not copy this draft. Try again.')

// Rerun denies asynchronous clipboard access. Use Chromium's ordinary, user-activated
// Copy command so the Mac receives only the chosen plain text and no read permission.
function copyReplyText(text: string) {
    if (window.top !== window || !navigator.userActivation?.isActive) throw Error('Copy requires an active user gesture')
    let written = false
    const onCopy = (event: ClipboardEvent) => {
        event.preventDefault()
        if (!event.clipboardData) return
        event.clipboardData.setData('text/plain', text)
        written = true
    }
    document.addEventListener('copy', onCopy, { once: true })
    try {
        if (!document.execCommand('copy') || !written) throw Error('Could not copy reply')
    } finally {
        document.removeEventListener('copy', onCopy)
    }
}

function DesktopDraftBlock(props: CustomRendererProps) {
    return <DraftBlock {...props} writeText={copyReplyText} onCopyError={draftCopyFailed} />
}

const answerPlugins: PluginConfig = { renderers: [{ language: DRAFT_LANGUAGE, component: DesktopDraftBlock }] }

function replyMarkdown(text: string, streaming = false, plugins: PluginConfig = noPlugins) {
    return <MessageResponse components={desktopComponents} plugins={plugins} rehypePlugins={noRehypePlugins}
        controls={false} skipHtml mode={streaming ? 'streaming' : 'static'} isAnimating={streaming}
        className="min-w-0 wrap-anywhere [&_pre]:overflow-x-auto">
        {text}
    </MessageResponse>
}

function DesktopAnswerBubbles({ text, streaming }: { text: string; streaming: boolean }) {
    const bubbles = useMemo(() => splitIntoBubbles(text), [text])
    return <div className="flex w-full flex-col items-start gap-1.5">
        {bubbles.map(({ frame, markdown }, index) => (
            <div key={index} data-bubble-frame={frame} className={cn('min-w-0', frame === 'bare' ? 'w-full' : 'max-w-[88%]', frame === 'bubble' && [AGENT_BUBBLE_SURFACE, 'px-3.5 py-2'])}>
                {replyMarkdown(markdown, streaming && index === bubbles.length - 1, answerPlugins)}
            </div>
        ))}
    </div>
}

function FeedbackThumb({ rating, current, onRate }: { rating: MessageFeedbackRating; current: MessageFeedbackRating | null; onRate: (rating: MessageFeedbackRating) => void }) {
    const pressed = current === rating
    const Glyph = rating === 'up' ? ThumbsUpIcon : ThumbsDownIcon
    return (
        <MessageAction tooltip={rating === 'up' ? 'Good response' : 'Bad response'} aria-pressed={pressed} className={cn(pressed ? 'bg-accent text-foreground' : 'text-muted-foreground')} onClick={() => onRate(rating)}>
            <Glyph className="size-3.5" />
        </MessageAction>
    )
}

export function DesktopAssistantReply({ message, streaming, onRegenerate, feedbackRating = null, onRate }: {
    message: UIMessage
    streaming: boolean
    onRegenerate?: (id: string) => void
    feedbackRating?: MessageFeedbackRating | null
    onRate?: (rating: MessageFeedbackRating) => void
}) {
    const { copied, copy } = useCopy(copyFailed, copyReplyText)
    const blocks: ReactNode[] = []
    let text = '', paragraph = ''
    for (const [index, part] of message.parts.entries()) {
        const live = streaming && index === message.parts.length - 1
        if (part.type === 'text') {
            text += part.text
            paragraph += part.text
            // A table or fenced block can span consecutive text parts from the model.
            if (message.parts[index + 1]?.type !== 'text') {
                blocks.push(<DesktopAnswerBubbles key={index} text={paragraph} streaming={live} />)
                paragraph = ''
            }
        } else if (part.type === 'reasoning' && isDesktopSummaryMetadata(part.providerMetadata) && (part.text || live)) {
            blocks.push(<ReasoningStep key={index} text={part.text} isStreaming={live} renderText={replyMarkdown} />)
        }
    }
    return <>
        {blocks}
        {text && !streaming && <div className="mt-2 flex flex-wrap items-center gap-1">
            <Button type="button" variant="ghost" size="sm" aria-label="Copy reply" onClick={() => copy(text)}>
                {copied ? <CheckIcon aria-hidden className="size-3.5" /> : <CopyIcon aria-hidden className="size-3.5" />}
                {copied ? 'Copied' : 'Copy'}
            </Button>
            {onRegenerate && <Button type="button" variant="ghost" size="sm" title="Opens a new chat and keeps the original"
                aria-description="Opens a new chat and keeps the original" onClick={() => onRegenerate(message.id)}>
                <RefreshCcwIcon aria-hidden className="size-3.5" /> Regenerate reply
            </Button>}
            {onRate && message.id.startsWith('engine-') && <div className={cn('flex items-center gap-1 transition-opacity group-hover:opacity-100 focus-within:opacity-100', feedbackRating == null && 'opacity-0')}>
                <FeedbackThumb rating="up" current={feedbackRating} onRate={onRate} />
                <FeedbackThumb rating="down" current={feedbackRating} onRate={onRate} />
            </div>}
        </div>}
    </>
}
