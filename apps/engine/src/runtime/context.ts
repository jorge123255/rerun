import type { DesktopCompactionReceipt, DesktopResolvedDocument } from '@rerun/contracts'
import type { DesktopCoworkerMention, DesktopWorkspaceAttachment, DesktopResolvedAttachment, MessageAuthor, Provider } from '@rerun/contracts'
import type { UIMessageStreamWriter } from 'ai'
import type { TurnOrder } from '../agents/turn-order.js'
import type { LoadedAgent } from '../agents/types.js'
import type { AgentRow, MessageRow } from '../db/schema.js'
import type { Logger } from '../lib/logger.js'
import type { HostBreaker } from '../tools/host-breaker.js'
import type { ScreenshotStore } from './screenshots.js'

export type RunTrigger = { source: 'chat'; coworkerMentions?: DesktopCoworkerMention[]; author?: MessageAuthor; userLanguage?: string; workspaceAttachment?: DesktopWorkspaceAttachment; workspaceAttachments?: DesktopWorkspaceAttachment[]; desktopAttachments?: DesktopResolvedAttachment[]; desktopDocuments?: DesktopResolvedDocument[]; savedUser?: MessageRow; queuedUser?: MessageRow; calledBy?: string; foremanAlternate?: true } | { source: 'schedule'; slug: string; name: string; requireExactModel?: boolean } | { source: 'trigger'; slug: string; name: string }

export type PartialResult = { label: string; text: string }

export type SkillProposalNotice = { proposalId: string; mode: string; title: string }

export type RunContext = {
    agent: LoadedAgent
    sessionId: string
    runId?: string
    logger: Logger
    provider: Provider
    model: string
    turnOrder: TurnOrder
    author?: MessageAuthor
    writer?: UIMessageStreamWriter
    abortSignal?: AbortSignal
    callTargets?: AgentRow[]
    hostBreaker?: HostBreaker
    partialResults?: PartialResult[]
    skillProposals?: SkillProposalNotice[]
    compactionReceipt?: DesktopCompactionReceipt
    screenshots?: ScreenshotStore
}
