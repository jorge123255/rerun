'use client'

import { getToolName, isToolUIPart, type UIMessage } from 'ai'
import { desktopSourceParts, QUICK_REPLIES_TOOL, stripBridgePrefix, skillProposalIdOf, isPinnable, type MessageFeedbackRating } from '@rerun/contracts'
import { useMemo, type ReactElement, type ReactNode } from 'react'
import { toast } from 'sonner'
import { MessageAction, MessageActions } from '@/components/ai-elements/message'
import { DesktopWorkspaceMessage, type DesktopOpenWorkspaceFile } from './DesktopWorkspaceMessage'
import { Source, Sources, SourcesContent, SourcesTrigger } from '@/components/ai-elements/sources'
import { MessageTimeTooltip } from '@/components/chat/MessageTimeTooltip'
import { desktopLocaleTag } from '@/lib/desktop/locale'
import { useDesktopLocale } from './DesktopLocale'
import { AGENT_BUBBLE_SURFACE } from '@/components/chat/bubble-styles'
import { CompactionStep } from '@/components/chat/CompactionBlock'
import { ReasoningStep } from '@/components/chat/ReasoningBlock'
import { StepGroup, type StepGroupItem } from '@/components/chat/StepGroup'
import { DesktopSetupCompleteCard } from './setup/DesktopSetupEventCards'
import { DesktopToolInstallCard } from './tool-install/DesktopToolInstallCard'
import { desktopToolInstallReferenceOf } from '@/lib/desktop/tool-install-reference'
import { DesktopToolStep, desktopToolStepDisplay } from './DesktopToolStep'
import { DesktopHistoricalCardView, selectDesktopHistoricalCard } from './tool-presentations'
import { projectDesktopToolStatus, resolveDesktopHistoricalIdentity, type DesktopHistoricalIdentity } from './tool-presentations/status'
import { DesktopTableResult } from './DesktopTableResult'
import { desktopTableCardOf } from '@/lib/desktop/table-card'
import type { DesktopAgentView } from './DesktopApp'
import { DesktopFileCard } from './DesktopFileCard'
import { saveDesktopResultFile } from '@/lib/desktop/result-file-save'
import { DesktopQuickReplies } from './DesktopQuickReplies'
import type { DesktopQuickReplySend } from '@/lib/desktop/quick-replies'
import { BrainIcon, CheckIcon, CopyIcon, FoldVerticalIcon, RefreshCcwIcon, ThumbsDownIcon, ThumbsUpIcon } from '@/lib/icons'
import { isDesktopSummaryMetadata } from '@/lib/desktop/reasoning-summary'
import { desktopCompactionSteps } from '@/lib/desktop/compaction'
import { desktopFileCardOf, desktopImageGenerationOutput } from '@/lib/desktop/file-card'
import { useCopy } from '@/lib/use-copy'
import { copyDesktopPlainText } from '@/lib/desktop/clipboard'
import { desktopDraftPlugins } from './DesktopDraftBlock'
import { splitIntoBubbles } from '@/lib/chat/message-bubbles'
import { cn } from '@/lib/utils'
import { DesktopBrainProposalBlock } from './brain/proposals/DesktopBrainProposalBlock'
import { DesktopSkillProposalBlock } from './skills/DesktopSkillProposalBlock'
import type { EngineSkillProposal } from '@/lib/engine/types'
import { DesktopCoworkerCalls } from './coworker-calls/DesktopCoworkerCalls'
import { DesktopDelegationMount } from './delegation/DesktopDelegationMount'
import type { DesktopCoworkerCallOpenTarget } from '@/lib/desktop/coworker-calls-client'


function replyMarkdown(text: string, streaming = false) {
    return <DesktopWorkspaceMessage streaming={streaming}>{text}</DesktopWorkspaceMessage>
}

function DesktopAnswerBubbles({ text, streaming, createdAt, agentId, onOpenWorkspaceFile }: {
    text: string
    streaming: boolean
    latest?: boolean
    createdAt?: string
    agentId?: string
    onOpenWorkspaceFile?: DesktopOpenWorkspaceFile
}) {
    const { language } = useDesktopLocale()
    const locale = desktopLocaleTag(language.locale)
    const bubbles = useMemo(() => splitIntoBubbles(text), [text])
    return <div className="flex w-full flex-col items-start gap-1.5">
        {bubbles.map(({ frame, markdown }, index) => (
            <MessageTimeTooltip key={index} createdAt={index === 0 ? createdAt : undefined} locale={locale} side="right">
                <div data-bubble-frame={frame} className={cn('min-w-0', frame === 'bare' ? 'w-full' : 'max-w-[88%]', frame === 'bubble' && [AGENT_BUBBLE_SURFACE, 'px-3.5 py-2'])}>
                    <DesktopWorkspaceMessage agentId={agentId} onOpenWorkspaceFile={onOpenWorkspaceFile}
                        streaming={streaming && index === bubbles.length - 1} plugins={desktopDraftPlugins}>{markdown}</DesktopWorkspaceMessage>
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
    const { t } = useDesktopLocale()
    const pressed = current === rating
    const Glyph = rating === 'up' ? ThumbsUpIcon : ThumbsDownIcon
    return (
        <MessageAction tooltip={t(rating === 'up' ? 'replyActions.goodResponse' : 'replyActions.badResponse')} aria-pressed={pressed} className={cn(pressed ? 'bg-accent text-foreground' : 'text-muted-foreground')} onClick={() => onRate(rating)}>
            <Glyph className="size-3.5" />
        </MessageAction>
    )
}

export function DesktopAssistantReply({ message, streaming, latest = streaming, createdAt, onRegenerate, feedbackRating = null, onRate, pendingRequestToolCallId, answeredRequestCalls, quickReplies, agentId, agent, skillProposals, childRuns, toolInstall, onOpenWorkspaceFile }: {
    message: UIMessage
    streaming: boolean
    latest?: boolean
    createdAt?: string
    onRegenerate?: (id: string) => void
    feedbackRating?: MessageFeedbackRating | null
    onRate?: (rating: MessageFeedbackRating) => void
    pendingRequestToolCallId?: string
    answeredRequestCalls?: ReadonlySet<string>
    quickReplies?: { show: boolean; disabled: boolean; pending: boolean; onSend: DesktopQuickReplySend }
    /** The trusted local coworker id that owns this conversation; needed to open a result card. */
    agentId?: string
    agent?: DesktopAgentView
    childRuns?: { sessionId: string; active: boolean; onOpenTarget?: (target: DesktopCoworkerCallOpenTarget) => Promise<void> }
    toolInstall?: { sessionId: string; active: boolean; disabled?: boolean }
    onOpenWorkspaceFile?: DesktopOpenWorkspaceFile
    skillProposals?: { rows: ReadonlyMap<string, EngineSkillProposal>; pinnedIds: ReadonlySet<string>; pendingId: string | null; onDecide?: (id: string, decision: 'accept' | 'dismiss') => void; onOpenSkill?: (slug: string) => void }
}) {
    const compactions = desktopCompactionSteps(message.parts, streaming)
    const lastStepIndex = streaming ? message.parts.findLastIndex(part => !part.type.startsWith('data-')) : -1
    const { t } = useDesktopLocale()
    const { copied, copy } = useCopy(() => toast.error(t('copyReplyFailed')), copyDesktopPlainText)
    const blocks: (ReactElement | StepGroupItem[])[] = []
    let group: StepGroupItem[] = []
    let groupIdentity: DesktopHistoricalIdentity | undefined
    let lastGroup: StepGroupItem[] | undefined
    const flushSteps = () => {
        if (!group.length) return
        blocks.push(group)
        lastGroup = group
        group = []
        groupIdentity = undefined
    }
    const appendBlock = (node: ReactElement) => {
        flushSteps()
        blocks.push(node)
    }
    let text = '', paragraph = ''
    let replyTime = createdAt
    const restored = message.id.startsWith('engine-')
    for (const [index, part] of message.parts.entries()) {
        const live = index === lastStepIndex
        if (part.type === 'text') {
            text += part.text
            paragraph += part.text
            // A table or fenced block can span consecutive text parts from the model.
            if (message.parts[index + 1]?.type !== 'text') {
                if (paragraph.trim()) {
                    appendBlock(<DesktopAnswerBubbles key={index} text={paragraph} streaming={live} createdAt={replyTime} agentId={agentId} onOpenWorkspaceFile={onOpenWorkspaceFile} />)
                    replyTime = undefined
                }
                paragraph = ''
            }
        } else if (isToolUIPart(part)) {
            const toolName = stripBridgePrefix(getToolName(part))
            if (part.toolCallId === pendingRequestToolCallId || toolName === QUICK_REPLIES_TOOL) continue
            if (part.state === 'output-available' && answeredRequestCalls?.has(part.toolCallId) &&
                (toolName === 'ask_user' || toolName === 'request_approval')) continue
            const receiptContext = { ownerId: agentId ?? null, live: streaming }
            if (childRuns && agentId && (toolName === 'call_agent' || toolName === 'delegate_tasks')) {
                const fallback = <DesktopToolStep part={part} restored={restored} context={receiptContext} />
                appendBlock(toolName === 'call_agent'
                    ? <DesktopCoworkerCalls key={part.toolCallId} agentId={agentId} sessionId={childRuns.sessionId} toolCallId={part.toolCallId} active={childRuns.active} currentRunActive={streaming} fallback={fallback} onOpenTarget={childRuns.onOpenTarget} />
                    : <DesktopDelegationMount key={part.toolCallId} agentId={agentId} sessionId={childRuns.sessionId} toolCallId={part.toolCallId} view={childRuns.active ? 'live' : 'history'} followLive={streaming} fallback={fallback} />)
                continue
            }
            if (toolName === 'tool_install' && part.state === 'output-available' && toolInstall && agentId) {
                const reference = desktopToolInstallReferenceOf(part.output)
                if (reference && reference.agentId === agentId && reference.sessionId === toolInstall.sessionId && reference.toolCallId === part.toolCallId) {
                    appendBlock(<DesktopToolInstallCard key={reference.operationId} sessionId={toolInstall.sessionId} operationId={reference.operationId} active={toolInstall.active} disabled={toolInstall.disabled} />)
                    continue
                }
            }
            if(toolName==='install_complete' && part.state==='output-available') {
                let output:unknown=part.output
                if(typeof output==='string'){try{output=JSON.parse(output)}catch{}}
                if(output && typeof output==='object' && 'status' in output && output.status==='complete') {
                    appendBlock(<DesktopSetupCompleteCard key={part.toolCallId} agentName={agent?.name} summary={'summary' in output && typeof output.summary==='string'?output.summary:''} schedules={[]} triggers={[]} />)
                    continue
                }
            }
            if (toolName === 'brain_propose' && part.state === 'output-available') {
                let value: unknown = part.output
                if (typeof value === 'string') { try { value = JSON.parse(value) } catch { value = null } }
                if (value && typeof value === 'object' && 'proposalId' in value && 'title' in value && typeof value.title === 'string' && 'status' in value && ['proposed','updated'].includes(String(value.status))) {
                    appendBlock(<DesktopBrainProposalBlock key={part.toolCallId} title={value.title} mode="edit" onReview={()=>window.dispatchEvent(new Event('rerun-desktop-open-brain'))}/>)
                    continue
                }
            }
            if (toolName === 'skill_propose' && part.state === 'output-available') {
                const id = skillProposalIdOf(part.output)
                const proposal = id ? skillProposals?.rows.get(id) : undefined
                if (proposal && !skillProposals?.pinnedIds.has(proposal.id)) appendBlock(<DesktopSkillProposalBlock key={part.toolCallId} pinned={false} proposal={proposal}
                    pending={skillProposals?.pendingId === proposal.id || proposal.status === 'accepted'}
                    onDecide={skillProposals?.onDecide && isPinnable(proposal.status) ? decision => skillProposals.onDecide?.(proposal.id, decision) : undefined}
                    onOpenSkill={proposal.appliedSlug && skillProposals?.onOpenSkill ? () => skillProposals.onOpenSkill?.(proposal.appliedSlug!) : undefined} />)
                continue
            }
            if ((toolName === 'card_file' || toolName === 'image_generation') && part.state === 'output-available') {
                const card = desktopFileCardOf(part.output)
                if (card) {
                    appendBlock(<DesktopFileCard key={part.toolCallId} agentId={agentId} card={card} saveResultFile={saveDesktopResultFile} />)
                    continue
                }
                if (toolName === 'image_generation') {
                    const notice = desktopImageGenerationOutput(part.output)
                    appendBlock(<DesktopToolStep key={part.toolCallId} part={{ ...part, state: 'output-error', errorText: notice, output: undefined }} restored={restored} context={receiptContext} />)
                    continue
                }
            }
            if (toolName === 'card_table' && part.state === 'output-available') {
                const card = desktopTableCardOf(part.output)
                if (card) {
                    appendBlock(<DesktopTableResult key={part.toolCallId} agent={agent} card={card} />)
                    continue
                }
            }
            const historical = selectDesktopHistoricalCard(part, { ownerId: agentId })
            if (historical) {
                appendBlock(<DesktopHistoricalCardView key={part.toolCallId} card={historical} onOpenBrain={historical.kind === 'brain-change' && historical.showOpen ? () => window.dispatchEvent(new Event('rerun-desktop-open-brain')) : undefined} />)
                continue
            }
            const status = projectDesktopToolStatus(part, receiptContext)
            if (toolName === 'notify_user' && (status === 'failed' || status === 'unknown')) continue
            const step = <DesktopToolStep key={part.toolCallId} part={part} restored={restored} context={receiptContext} />
            const identity = resolveDesktopHistoricalIdentity(part, receiptContext)
            if (!identity.ok || (status !== 'running' && status !== 'succeeded' && status !== 'failed')) {
                appendBlock(step)
                continue
            }
            if (groupIdentity && (groupIdentity.ownerId !== identity.identity.ownerId
                || groupIdentity.workspaceId !== identity.identity.workspaceId || groupIdentity.runId !== identity.identity.runId)) flushSteps()
            groupIdentity = identity.identity
            const display = desktopToolStepDisplay(toolName)
            group.push({
                key: part.toolCallId,
                iconProps: { icon: display.icon },
                node: step,
                status: status === 'failed' ? 'error' : status === 'succeeded' ? 'done' : 'running',
                runningLabel: t('chatActivity.runningTool', { tool: display.label }),
            })
        } else if (part.type === 'data-compaction') {
            const step = compactions.get(index)
            if (step) group.push({
                key: step.key,
                iconProps: { icon: FoldVerticalIcon },
                node: <CompactionStep data={step.data} />,
                status: step.data.status,
                runningLabel: t('chatSteps.compacting'),
            })
        } else if (part.type === 'reasoning' && isDesktopSummaryMetadata(part.providerMetadata) && (part.text || live)) {
            const thinking = live && part.state === 'streaming'
            group.push({
                key: `reasoning-${index}`,
                iconProps: { icon: BrainIcon },
                node: <ReasoningStep text={part.text} isStreaming={thinking} renderText={replyMarkdown} />,
                status: thinking ? 'running' : 'done',
                runningLabel: t('chatSteps.thinking'),
            })
        }
    }
    flushSteps()
    return <>
        {blocks.map(block => {
            if (!Array.isArray(block)) return block
            const count = t('chatSteps.count', { count: block.length })
            const failed = block.filter(item => item.status === 'error').length
            return <StepGroup key={`steps-${block[0].key}`} items={block} agentId={latest && block === lastGroup ? agentId : undefined}
                labels={{ count, accessible: failed ? t('chatSteps.countWithFailures', { count: block.length, failed }) : count, failed: t('chatSteps.failed', { failed }) }} />
        })}
        <DesktopReplySources parts={message.parts} />
        {quickReplies && <DesktopQuickReplies message={message} {...quickReplies} />}
        {text.trim() && !streaming && <MessageActions data-chat-find-ignore
            className={cn('mt-1 flex-wrap transition-opacity group-hover:opacity-100 focus-within:opacity-100',
                feedbackRating == null && '[@media(hover:hover)]:opacity-0')}>
            <MessageAction tooltip={t(copied ? 'replyActions.copied' : 'replyActions.copy')}
                aria-label={t(copied ? 'replyActions.copied' : 'copyReply')} onClick={() => copy(text)}>
                {copied ? <CheckIcon aria-hidden className="size-3.5" /> : <CopyIcon aria-hidden className="size-3.5" />}
            </MessageAction>
            {onRegenerate && <MessageAction label={t('replyActions.regenerate')} aria-description={t('regenerateReplyHint')}
                tooltip={`${t('replyActions.regenerate')} · ${t('regenerateReplyHint')}`} onClick={() => onRegenerate(message.id)}>
                <RefreshCcwIcon aria-hidden className="size-3.5" />
            </MessageAction>}
            {onRate && message.id.startsWith('engine-') && <>
                <FeedbackThumb rating="up" current={feedbackRating} onRate={onRate} />
                <FeedbackThumb rating="down" current={feedbackRating} onRate={onRate} />
            </>}
        </MessageActions>}
    </>
}
