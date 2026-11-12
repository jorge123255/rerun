import { Fragment } from 'react'
import { MENTION_TOKEN_CLASSES } from '@/components/chat/composer-token-styles'
import { composerUrlRanges, shortenUrl } from '@/lib/chat/composer-links'
import { DesktopChatLinkLabel, safeDesktopChatLink } from '../DesktopChatLinkLabel'
import { desktopCoworkerMentionsFromMetadata } from './coworker-mention-model'

/** Selected mention styling uses exact saved ranges. Link labels never change the stored text. */
export function DesktopSelectedMentionText({ text, metadata, linkify = true }: { text: string; metadata: unknown; linkify?: boolean }) {
    const mentions = desktopCoworkerMentionsFromMetadata(text, metadata)
    const links = linkify ? composerUrlRanges(text).filter(link => safeDesktopChatLink(link.url) &&
        !mentions.some(mention => mention.start < link.end && link.start < mention.end)) : []
    const tokens = [...mentions, ...links].sort((left, right) => left.start - right.start)
    let end = 0
    const parts = tokens.map(token => {
        const before = text.slice(end, token.start)
        end = token.end
        return <Fragment key={token.start}>
            {before}
            {'url' in token
                ? <a href={token.url} target="_blank" rel="noopener noreferrer" data-streamdown="link">
                    <DesktopChatLinkLabel title={token.url}>{shortenUrl(token.url)}</DesktopChatLinkLabel>
                </a>
                : <span className={MENTION_TOKEN_CLASSES.agent}>{token.token}</span>}
        </Fragment>
    })
    return <span>{parts}{text.slice(end)}</span>
}
