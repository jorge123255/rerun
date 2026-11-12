'use client'

import { getToolName, isToolUIPart, type UIMessage } from 'ai'
import { desktopSourceParts, QUICK_REPLIES_TOOL, stripBridgePrefix, skillProposalIdOf, isPinnable, type MessageFeedbackRating } from '@rerun/contracts'
import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { defaultRemarkPlugins, type Components, type CustomRendererProps, type PluginConfig } from 'streamdown'
import { toast } from 'sonner'
import { MessageAction, MessageResponse, type MessageResponseProps } from '@/components/ai-elements/message'
import { AGENT_WORKSPACE_FILE_PATH_ATTRIBUTE, AGENT_WORKSPACE_FILE_TAG, remarkAgentWorkspaceLinks } from '@/lib/files/workspace-link'
import { desktopWorkspaceFileLink } from '@/lib/desktop/workspace-file-link'
import { Source, Sources, SourcesContent, SourcesTrigger } from '@/components/ai-elements/sources'
import { DRAFT_LANGUAGE, DraftBlock } from '@/components/chat/DraftBlock'
import { MessageTimeTooltip } from '@/components/chat/MessageTimeTooltip'
import { desktopLocaleTag } from '@/lib/desktop/locale'
import { useDesktopLocale } from './DesktopLocale'
import { AGENT_BUBBLE_SURFACE } from '@/components/chat/bubble-styles'
import { CompactionStep } from '@/components/chat/CompactionBlock'
import { ReasoningStep } from '@/components/chat/ReasoningBlock'
import { DesktopSetupCompleteCard } from './setup/DesktopSetupEventCards'
import { DesktopToolInstallCard } from './tool-install/DesktopToolInstallCard'
import { desktopToolInstallReferenceOf } from '@/lib/desktop/tool-install-reference'
import { DesktopToolStep } from './DesktopToolStep'
import { DesktopHistoricalCardView, selectDesktopHistoricalCard } from './tool-presentations'
import { projectDesktopToolStatus } from './tool-presentations/status'
import { DesktopTableResult } from './DesktopTableResult'
import { desktopTableCardOf } from '@/lib/desktop/table-card'
import type { DesktopAgentView } from './DesktopApp'
import { DesktopFileCard } from './DesktopFileCard'
import { saveDesktopResultFile } from '@/lib/desktop/result-file-save'
import { DesktopQuickReplies } from './DesktopQuickReplies'
import type { DesktopQuickReplySend } from '@/lib/desktop/quick-replies'
import { Button } from '@/components/ui/button'
import { CheckIcon, CopyIcon, RefreshCcwIcon, ThumbsDownIcon, ThumbsUpIcon } from '@/lib/icons'
import { isDesktopSummaryMetadata } from '@/lib/desktop/reasoning-summary'
import { desktopCompactionSteps } from '@/lib/desktop/compaction'
import { desktopFileCardOf, desktopImageGenerationOutput } from '@/lib/desktop/file-card'
import { useCopy } from '@/lib/use-copy'
import { splitIntoBubbles } from '@/lib/chat/message-bubbles'
import { cn } from '@/lib/utils'
import { DesktopBrainProposalBlock } from './brain/proposals/DesktopBrainProposalBlock'
import { DesktopSkillProposalBlock } from './skills/DesktopSkillProposalBlock'
import type { EngineSkillProposal } from '@/lib/engine/types'
import { DesktopCoworkerCalls } from './coworker-calls/DesktopCoworkerCalls'
import { DesktopDelegationMount } from './delegation/DesktopDelegationMount'
import type { DesktopCoworkerCallOpenTarget } from '@/lib/desktop/coworker-calls-client'

type OpenWorkspaceFile = (href: string, opener: HTMLElement) => void
const WorkspaceFileContext = createContext<OpenWorkspaceFile | undefined>(undefined)
const workspaceFileTags = { [AGENT_WORKSPACE_FILE_TAG]: [AGENT_WORKSPACE_FILE_PATH_ATTRIBUTE] }
const workspaceLinks: MessageResponseProps['remarkPlugins'] = [
    ...Object.values(defaultRemarkPlugins),
    [remarkAgentWorkspaceLinks, { linkPath: (href: string | undefined) => href && desktopWorkspaceFileLink(href) ? href : null }],
]

function WorkspaceFileLink({ path, children }: { path?: string; children?: ReactNode; node?: unknown }) {
    const open = useContext(WorkspaceFileContext)
    const link = desktopWorkspaceFileLink(path)
    if (!path || !link || !open) return <span>{children}</span>
    return <button type="button" data-streamdown="link" title={`Open ${link.path}`}
        className="wrap-anywhere appearance-none text-left font-medium text-primary underline"
        onClick={event => open(path, event.currentTarget)}>{children}</button>
}

const desktopComponents: Components = {
    [AGENT_WORKSPACE_FILE_TAG]: WorkspaceFileLink,
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

function replyMarkdown(text: string, streaming = false, plugins: PluginConfig = noPlugins, remarkPlugins?: MessageResponseProps['remarkPlugins']) {
    return <MessageResponse components={desktopComponents} plugins={plugins} rehypePlugins={noRehypePlugins}
        remarkPlugins={remarkPlugins} allowedTags={remarkPlugins ? workspaceFileTags : undefined}
        controls={false} skipHtml mode={streaming ? 'streaming' : 'static'} isAnimating={streaming}
        className="min-w-0 wrap-anywhere [&_pre]:overflow-x-auto">
        {text}
    </MessageResponse>
}

function DesktopAnswerBubbles({ text, streaming, createdAt, workspaceLinks }: {
    text: string
    streaming: boolean
    createdAt?: string
    workspaceLinks?: MessageResponseProps['remarkPlugins']
}) {
    const { language } = useDesktopLocale()
    const locale = desktopLocaleTag(language.locale)
    const bubbles = useMemo(() => splitIntoBubbles(text), [text])
    return <div className="flex w-full flex-col items-start gap-1.5">
        {bubbles.map(({ frame, markdown }, index) => (
            <MessageTimeTooltip key={index} createdAt={index === 0 ? createdAt : undefined} locale={locale} side="right">
                <div data-bubble-frame={frame} className={cn('min-w-0', frame === 'bare' ? 'w-full' : 'max-w-[88%]', frame === 'bubble' && [AGENT_BUBBLE_SURFACE, 'px-3.5 py-2'])}>
                    {replyMarkdown(markdown, streaming && index === bubbles.length - 1, answerPlugins, workspaceLinks)}
                </div>
            </MessageTimeTooltip>
        ))}
    </div>
}

function DesktopReplySources({ parts }: Pick<UIMessage, 'parts'>) {
    // The SDK streams all steps into one UIMessage. Saved assistant rows each hold one step.
    const steps: UIMessage['parts'][] = [[]]
    for (const part of parts) {
        if (part.type === 'step-start') steps.push([])
        else if (part.type === 'source-url' || part.type === 'source-document') steps[steps.length - 1].push(part)
    }
    const sources = steps.flatMap((parts, step) => desktopSourceParts(parts).map(source => ({ source, key: `${step}-${source.sourceId}` })))
    return sources.length > 0 ? (
        <Sources>
            <SourcesTrigger count={sources.length} />
            <SourcesContent>
                {sources.map(({ source, key }) => source.type === 'source-url'
                    ? <Source key={key} href={source.url} title={source.title ?? source.url} rel="noopener noreferrer" />
                    : <Source key={key} title={source.title} target={undefined} className="flex items-center gap-2" />)}
            </SourcesContent>
        </Sources>
    ) : null
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

export function DesktopAssistantReply({ message, streaming, createdAt, onRegenerate, feedbackRating = null, onRate, pendingRequestToolCallId, quickReplies, agentId, agent, skillProposals, childRuns, toolInstall, onOpenWorkspaceFile }: {
    message: UIMessage
    streaming: boolean
    createdAt?: string
    onRegenerate?: (id: string) => void
    feedbackRating?: MessageFeedbackRating | null
    onRate?: (rating: MessageFeedbackRating) => void
    pendingRequestToolCallId?: string
    quickReplies?: { show: boolean; disabled: boolean; pending: boolean; onSend: DesktopQuickReplySend }
    /** The trusted local coworker id that owns this conversation; needed to open a result card. */
    agentId?: string
    agent?: DesktopAgentView
    childRuns?: { sessionId: string; active: boolean; onOpenTarget?: (target: DesktopCoworkerCallOpenTarget) => Promise<void> }
    toolInstall?: { sessionId: string; active: boolean; disabled?: boolean }
    onOpenWorkspaceFile?: OpenWorkspaceFile
    skillProposals?: { rows: ReadonlyMap<string, EngineSkillProposal>; pinnedIds: ReadonlySet<string>; pendingId: string | null; onDecide?: (id: string, decision: 'accept' | 'dismiss') => void; onOpenSkill?: (slug: string) => void }
}) {
    const { copied, copy } = useCopy(copyFailed, copyReplyText)
    const compactions = desktopCompactionSteps(message.parts, streaming)
    const blocks: ReactNode[] = []
    let text = '', paragraph = ''
    let replyTime = createdAt
    for (const [index, part] of message.parts.entries()) {
        const live = streaming && index === message.parts.length - 1
        if (part.type === 'text') {
            text += part.text
            paragraph += part.text
            // A table or fenced block can span consecutive text parts from the model.
            if (message.parts[index + 1]?.type !== 'text') {
                blocks.push(<DesktopAnswerBubbles key={index} text={paragraph} streaming={live} createdAt={replyTime} workspaceLinks={onOpenWorkspaceFile ? workspaceLinks : undefined} />)
                if (paragraph.trim()) replyTime = undefined
                paragraph = ''
            }
        } else if (isToolUIPart(part)) {
            const toolName = stripBridgePrefix(getToolName(part))
            if (part.toolCallId === pendingRequestToolCallId || toolName === QUICK_REPLIES_TOOL) continue
            const receiptContext = { ownerId: agentId ?? null }
            if (childRuns && agentId && (toolName === 'call_agent' || toolName === 'delegate_tasks')) {
                const fallback = <DesktopToolStep part={part} restored={message.id.startsWith('engine-')} context={receiptContext} />
                blocks.push(toolName === 'call_agent'
                    ? <DesktopCoworkerCalls key={part.toolCallId} agentId={agentId} sessionId={childRuns.sessionId} toolCallId={part.toolCallId} active={childRuns.active} currentRunActive={streaming} fallback={fallback} onOpenTarget={childRuns.onOpenTarget} />
                    : <DesktopDelegationMount key={part.toolCallId} agentId={agentId} sessionId={childRuns.sessionId} toolCallId={part.toolCallId} view={childRuns.active ? 'live' : 'history'} followLive={streaming} fallback={fallback} />)
                continue
            }
            if (toolName === 'tool_install' && part.state === 'output-available' && toolInstall && agentId) {
                const reference = desktopToolInstallReferenceOf(part.output)
                if (reference && reference.agentId === agentId && reference.sessionId === toolInstall.sessionId && reference.toolCallId === part.toolCallId) {
                    blocks.push(<DesktopToolInstallCard key={reference.operationId} sessionId={toolInstall.sessionId} operationId={reference.operationId} active={toolInstall.active} disabled={toolInstall.disabled} />)
                    continue
                }
            }
            if(toolName==='install_complete' && part.state==='output-available') {
                let output:unknown=part.output
                if(typeof output==='string'){try{output=JSON.parse(output)}catch{}}
                if(output && typeof output==='object' && 'status' in output && output.status==='complete') {
                    blocks.push(<DesktopSetupCompleteCard key={part.toolCallId} agentName={agent?.name} summary={'summary' in output && typeof output.summary==='string'?output.summary:''} schedules={[]} triggers={[]} />)
                    continue
                }
            }
            if (toolName === 'brain_propose' && part.state === 'output-available') {
                let value: unknown = part.output
                if (typeof value === 'string') { try { value = JSON.parse(value) } catch { value = null } }
                if (value && typeof value === 'object' && 'proposalId' in value && 'title' in value && typeof value.title === 'string' && 'status' in value && ['proposed','updated'].includes(String(value.status))) {
                    blocks.push(<DesktopBrainProposalBlock key={part.toolCallId} title={value.title} mode="edit" onReview={()=>window.dispatchEvent(new Event('rerun-desktop-open-brain'))}/>)
                    continue
                }
            }
            if (toolName === 'skill_propose' && part.state === 'output-available') {
                const id = skillProposalIdOf(part.output)
                const proposal = id ? skillProposals?.rows.get(id) : undefined
                if (proposal && !skillProposals?.pinnedIds.has(proposal.id)) blocks.push(<DesktopSkillProposalBlock key={part.toolCallId} pinned={false} proposal={proposal}
                    pending={skillProposals?.pendingId === proposal.id || proposal.status === 'accepted'}
                    onDecide={skillProposals?.onDecide && isPinnable(proposal.status) ? decision => skillProposals.onDecide?.(proposal.id, decision) : undefined}
                    onOpenSkill={proposal.appliedSlug && skillProposals?.onOpenSkill ? () => skillProposals.onOpenSkill?.(proposal.appliedSlug!) : undefined} />)
                continue
            }
            if ((toolName === 'card_file' || toolName === 'image_generation') && part.state === 'output-available') {
                const card = desktopFileCardOf(part.output)
                if (card) {
                    blocks.push(<DesktopFileCard key={part.toolCallId} agentId={agentId} card={card} saveResultFile={saveDesktopResultFile} />)
                    continue
                }
                if (toolName === 'image_generation') {
                    const notice = desktopImageGenerationOutput(part.output)
                    blocks.push(<DesktopToolStep key={part.toolCallId} part={{ ...part, state: 'output-error', errorText: notice, output: undefined }} restored={message.id.startsWith('engine-')} context={receiptContext} />)
                    continue
                }
            }
            if (toolName === 'card_table' && part.state === 'output-available') {
                const card = desktopTableCardOf(part.output)
                if (card) {
                    blocks.push(<DesktopTableResult key={part.toolCallId} agent={agent} card={card} />)
                    continue
                }
            }
            const historical = selectDesktopHistoricalCard(part, { ownerId: agentId })
            if (historical) {
                blocks.push(<DesktopHistoricalCardView key={part.toolCallId} card={historical} onOpenBrain={historical.kind === 'brain-change' && historical.showOpen ? () => window.dispatchEvent(new Event('rerun-desktop-open-brain')) : undefined} />)
                continue
            }
            if (toolName === 'notify_user' && (projectDesktopToolStatus(part, { ownerId: agentId }) === 'failed' || projectDesktopToolStatus(part, { ownerId: agentId }) === 'unknown')) continue
            blocks.push(<DesktopToolStep key={part.toolCallId} part={part} restored={message.id.startsWith('engine-')} context={receiptContext} />)
        } else if (part.type === 'data-compaction') {
            const step = compactions.get(index)
            if (step) blocks.push(<CompactionStep key={step.key} data={step.data} />)
        } else if (part.type === 'reasoning' && isDesktopSummaryMetadata(part.providerMetadata) && (part.text || live)) {
            blocks.push(<ReasoningStep key={index} text={part.text} isStreaming={live} renderText={replyMarkdown} />)
        }
    }
    return <WorkspaceFileContext.Provider value={onOpenWorkspaceFile}>
        {blocks}
        <DesktopReplySources parts={message.parts} />
        {quickReplies && <DesktopQuickReplies message={message} {...quickReplies} />}
        {text && !streaming && <div data-chat-find-ignore className="mt-2 flex flex-wrap items-center gap-1">
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
    </WorkspaceFileContext.Provider>
}
