'use client'

import { Component, type ReactNode, type ComponentProps } from 'react'
import { defaultRemarkPlugins, type Components, type PluginConfig } from 'streamdown'
import { MessageResponse } from '@/components/ai-elements/message'
import { Source, Sources, SourcesContent, SourcesTrigger } from '@/components/ai-elements/sources'
import { COMPOSER_LINK_TAG, remarkShortLinks } from '@/lib/chat/composer-links'
import { safeForemanHistoryLink } from './parts'
import { DesktopChatLinkLabel, safeDesktopChatLink } from '../../DesktopChatLinkLabel'
import { DesktopHistoricalCardView } from '../../tool-presentations/DesktopHistoricalCardView'
import { DesktopHistoricalStepGroup } from '../../tool-presentations/DesktopHistoricalStepGroup'
import type { ForemanHistoryPart } from './parts'

const noPlugins: PluginConfig = {}
const noRehypePlugins: NonNullable<ComponentProps<typeof MessageResponse>['rehypePlugins']> = []
const components: Components = {
    a: ({ href, children }) => {
        const url = safeForemanHistoryLink(href)
        return url ? <a href={url} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>
    },
    img: ({ alt }) => <span>{alt || 'Image'}</span>,
}
const userLinkComponents: Components = {
    ...components,
    a: ({ href, children }) => safeDesktopChatLink(href)
        ? <a href={href} target="_blank" rel="noopener noreferrer" data-streamdown="link">{children}</a> : <span>{children}</span>,
    [COMPOSER_LINK_TAG]: DesktopChatLinkLabel,
}
const userLinkPlugins: NonNullable<ComponentProps<typeof MessageResponse>['remarkPlugins']> = [
    ...Object.values(defaultRemarkPlugins),
    [remarkShortLinks, { allow: safeDesktopChatLink }],
]
const userLinkTags = { [COMPOSER_LINK_TAG]: ['title'] }

class LiteralFallback extends Component<{ text: string; children: ReactNode }, { failed: boolean }> {
    state = { failed: false }
    static getDerivedStateFromError() { return { failed: true } }
    render() {
        return this.state.failed ? <div className="whitespace-pre-wrap break-words">{this.props.text}</div> : this.props.children
    }
}

function SavedMarkdown({ text, userLinks = false }: { text: string; userLinks?: boolean }) {
    return <LiteralFallback key={text} text={text}><MessageResponse components={userLinks ? userLinkComponents : components} plugins={noPlugins}
        allowedTags={userLinks ? userLinkTags : undefined} remarkPlugins={userLinks ? userLinkPlugins : undefined}
        rehypePlugins={noRehypePlugins} controls={false} skipHtml mode="static" isAnimating={false}
        className="min-w-0 wrap-anywhere [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto">
        {text}
    </MessageResponse></LiteralFallback>
}

function SavedSource({ url, title }: { url: string; title: string }) {
    const safe = safeForemanHistoryLink(url)
    return safe ? <Source href={safe} title={title} rel="noopener noreferrer" className="flex min-w-0 items-center gap-2 break-all text-xs underline" /> : <span className="break-words text-xs">{title}</span>
}

/** Pure saved-parts presentation. No action callbacks, resource readers or live widgets. */
export function DesktopForemanHistoryMessage({ history, userLinks }: { history: readonly ForemanHistoryPart[]; userLinks?: boolean }) {
    return <div className="flex min-w-0 max-w-full flex-col gap-2 break-words">
        {history.map(part => {
            switch (part.kind) {
                case 'text': return <div key={part.key} data-chat-find-message className="contents"><SavedMarkdown text={part.text} userLinks={userLinks} /></div>
                case 'reasoning': return <details key={part.key} className="text-xs text-muted-foreground"><summary>Thinking</summary><SavedMarkdown text={part.text} /></details>
                case 'link': return <SavedSource key={part.key} url={part.url} title={part.title} />
                case 'docs': return <Sources key={part.key} defaultOpen className="min-w-0 max-w-full">
                    <SourcesTrigger type="button" count={part.links.length} />
                    <SourcesContent className="w-full max-w-full min-w-0">
                        {part.note && <SavedMarkdown text={part.note} />}
                        {part.links.map((link, index) => <div key={`${index}:${link.url}`} className="min-w-0">
                            <SavedSource url={link.url} title={link.title} />
                            {link.text && <div className="max-h-48 overflow-auto text-xs"><SavedMarkdown text={link.text} /></div>}
                        </div>)}
                    </SourcesContent>
                </Sources>
                case 'card': return <DesktopHistoricalCardView key={part.key} card={part.card} />
                case 'tool': return <DesktopHistoricalStepGroup key={part.key} items={[part.item]} />
                case 'unknown': return <p key={part.key} className="text-xs text-muted-foreground" role="note">{part.label}</p>
            }
        })}
    </div>
}
