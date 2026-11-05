import { Fragment } from 'react'
import { MENTION_TOKEN_CLASSES } from '@/components/chat/composer-token-styles'
import { desktopCoworkerMentionsFromMetadata } from './coworker-mention-model'

/** Render only saved selected ranges; duplicate display names never create a new binding. */
export function DesktopSelectedMentionText({ text, metadata }: { text: string; metadata: unknown }) {
    const mentions = desktopCoworkerMentionsFromMetadata(text, metadata)
    if (!mentions.length) return <span>{text}</span>
    let end = 0
    const parts = mentions.map(mention => {
        const before = text.slice(end, mention.start)
        end = mention.end
        return <Fragment key={`${mention.start}:${mention.targetId}`}>{before}<span className={MENTION_TOKEN_CLASSES.agent}>{mention.token}</span></Fragment>
    })
    return <span>{parts}{text.slice(end)}</span>
}
