'use client'

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import { defaultRemarkPlugins, type Components, type PluginConfig } from 'streamdown'
import { MessageResponse, type MessageResponseProps } from '@/components/ai-elements/message'
import { MENTION_TOKEN_CLASSES } from '@/components/chat/composer-token-styles'
import { COMPOSER_LINK_TAG, COMPOSER_MENTION_TAG, remarkShortLinks } from '@/lib/chat/composer-links'
import { desktopWorkspaceFileLink, desktopWorkspaceImageUrl } from '@/lib/desktop/workspace-file-link'
import { AGENT_WORKSPACE_FILE_PATH_ATTRIBUTE, AGENT_WORKSPACE_FILE_TAG, remarkAgentWorkspaceLinks } from '@/lib/files/workspace-link'
import { DesktopChatLinkLabel, safeDesktopChatLink } from './DesktopChatLinkLabel'
import { desktopCoworkerMentionsFromMetadata } from './mentions/coworker-mention-model'

export type DesktopOpenWorkspaceFile = (href: string, opener: HTMLElement) => void
const WorkspaceContext = createContext<{ agentId?: string; openFile?: DesktopOpenWorkspaceFile }>({})
const defaultPlugins = Object.values(defaultRemarkPlugins)
const noPlugins = {}
const noRehypePlugins: [] = []
const workspaceLinkPlugin: NonNullable<MessageResponseProps['remarkPlugins']>[number] = [
    remarkAgentWorkspaceLinks,
    { linkPath: (href: string | undefined) => href && desktopWorkspaceFileLink(href) ? href : null },
]

function WorkspaceFileLink({ path, children }: { path?: string; children?: ReactNode; node?: unknown }) {
    const { openFile } = useContext(WorkspaceContext)
    const link = desktopWorkspaceFileLink(path)
    if (!path || !link || !openFile) return <span>{children}</span>
    return <button type="button" data-streamdown="link" title={`Open ${link.path}`}
        className="wrap-anywhere appearance-none text-left font-medium text-primary underline"
        onClick={event => openFile(path, event.currentTarget)}>{children}</button>
}

function WorkspaceImage({ src, alt }: { src: string; alt: string }) {
    const [failed, setFailed] = useState(false)
    return failed ? <span>{alt}</span> : <img src={src} alt={alt} loading="lazy" decoding="async"
        className="h-auto max-h-[32rem] max-w-full rounded-md border object-contain" onError={() => setFailed(true)} />
}

const components: Components = {
    [AGENT_WORKSPACE_FILE_TAG]: WorkspaceFileLink,
    [COMPOSER_LINK_TAG]: DesktopChatLinkLabel,
    [COMPOSER_MENTION_TAG]: ({ children }) => <span className={MENTION_TOKEN_CLASSES.agent}>{children}</span>,
    a: ({ href, children }) => safeDesktopChatLink(href)
        ? <a data-streamdown="link" href={href} target="_blank" rel="noopener noreferrer">{children}</a>
        : <span>{children}</span>,
    img: function WorkspaceMarkdownImage({ src, alt }) {
        const { agentId } = useContext(WorkspaceContext)
        const url = agentId && typeof src === 'string' ? desktopWorkspaceImageUrl(agentId, src) : null
        const label = alt || 'Image'
        return url ? <WorkspaceImage key={url} src={url} alt={label} /> : <span>{label}</span>
    },
}

type MarkdownNode = {
    type?: string
    value?: string
    children?: MarkdownNode[]
    position?: { start: { offset?: number }; end: { offset?: number } }
    data?: { hName: string }
}

/** A saved mention highlights only its recorded source range, never identical typed text. */
function remarkSavedCoworkerMentions({ text, metadata }: { text: string; metadata: unknown }) {
    const mentions = desktopCoworkerMentionsFromMetadata(text, metadata)
    return (tree: MarkdownNode) => {
        function visit(node: MarkdownNode) {
            if (!node.children || node.type === 'link' || node.type === 'linkReference') return
            node.children = node.children.flatMap(child => {
                if (child.type !== 'text') { visit(child); return [child] }
                const start = child.position?.start.offset, end = child.position?.end.offset
                if (start === undefined || end === undefined || child.value !== text.slice(start, end)) return [child]
                const selected = mentions.filter(mention => mention.start >= start && mention.end <= end)
                if (!selected.length) return [child]
                const parts: MarkdownNode[] = []
                let offset = start
                for (const mention of selected) {
                    if (offset < mention.start) parts.push({ type: 'text', value: text.slice(offset, mention.start) })
                    parts.push({ type: 'text', value: mention.token, data: { hName: COMPOSER_MENTION_TAG } })
                    offset = mention.end
                }
                if (offset < end) parts.push({ type: 'text', value: text.slice(offset, end) })
                return parts
            })
        }
        if (mentions.length) visit(tree)
    }
}

export function DesktopWorkspaceMessage({ children, agentId, onOpenWorkspaceFile, composer = false, metadata, streaming = false, plugins = noPlugins }: {
    children: string
    agentId?: string
    onOpenWorkspaceFile?: DesktopOpenWorkspaceFile
    composer?: boolean
    metadata?: unknown
    streaming?: boolean
    plugins?: PluginConfig
}) {
    const links = !!onOpenWorkspaceFile
    const remarkPlugins = useMemo(() => {
        if (!links && !composer) return undefined
        const result: NonNullable<MessageResponseProps['remarkPlugins']> = [...defaultPlugins]
        if (links) result.push(workspaceLinkPlugin)
        if (composer) result.push([remarkShortLinks, { allow: safeDesktopChatLink }], [remarkSavedCoworkerMentions, { text: children, metadata }])
        return result
    }, [links, composer, children, metadata])
    return <WorkspaceContext.Provider value={{ agentId, openFile: onOpenWorkspaceFile }}>
        <MessageResponse components={components} plugins={plugins} rehypePlugins={noRehypePlugins}
            remarkPlugins={remarkPlugins}
            allowedTags={{
                ...(links && { [AGENT_WORKSPACE_FILE_TAG]: [AGENT_WORKSPACE_FILE_PATH_ATTRIBUTE] }),
                ...(composer && { [COMPOSER_LINK_TAG]: ['title'], [COMPOSER_MENTION_TAG]: [] }),
            }}
            controls={false} skipHtml mode={streaming ? 'streaming' : 'static'} isAnimating={streaming}
            className="min-w-0 wrap-anywhere [&_pre]:overflow-x-auto">
            {children}
        </MessageResponse>
    </WorkspaceContext.Provider>
}
