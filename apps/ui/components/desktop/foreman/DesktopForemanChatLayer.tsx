'use client'

import { AnimatePresence, motion } from 'motion/react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { DesktopForemanDocsTool } from './docs/DesktopForemanDocsTool'
import type { UIMessage } from 'ai'
import {
    type DesktopForemanBuildProgressView,
    type DesktopForemanNextStep,
    type DesktopLeadSetupState,
    type DesktopPlanDecisionStatus,
    type DesktopTrustedPlanSnapshot,
    projectPlanCard,
} from '@/lib/desktop/foreman-client'
import { DesktopForemanWelcome } from './DesktopForemanWelcome'
import { DesktopPlanCard } from './plan/DesktopPlanCard'
import { DesktopForemanBuildProgress } from './DesktopForemanBuildProgress'
import { DesktopForemanNextSteps } from './DesktopForemanNextSteps'

export type DesktopForemanMessage = {
    id: string
    role: 'user' | 'assistant' | 'system'
    text: string
    docs?: UIMessage['parts']
}

export function DesktopForemanChatLayer({
    messages,
    streaming,
    restored,
    emptyWelcome,
    planSnapshot,
    decisionStatus,
    build,
    nextSteps,
    leadState,
    error,
    onConfirmPlan,
    onAskChanges,
    onRetryDecision,
    onResumeBuild,
    onStopBuild,
    buildBusy,
    onStartLead,
    onOpenCreated,
    onOpenCoworker,
    onOpenBox,
    children,
    className,
}: {
    messages: DesktopForemanMessage[]
    streaming?: boolean
    restored: boolean
    emptyWelcome?: boolean
    planSnapshot: DesktopTrustedPlanSnapshot | null
    decisionStatus: DesktopPlanDecisionStatus
    build: DesktopForemanBuildProgressView | null
    nextSteps: DesktopForemanNextStep[]
    leadState: DesktopLeadSetupState
    live: boolean
    error?: string | null
    onConfirmPlan: () => void
    onAskChanges: () => void
    onRetryDecision?: () => void
    onResumeBuild?: () => void
    onStopBuild?: () => void
    buildBusy?: boolean
    onStartLead: (step: Extract<DesktopForemanNextStep, { kind: 'start_lead' }>) => void | Promise<void>
    onOpenCreated: (step: Extract<DesktopForemanNextStep, { kind: 'open_created' }>) => void
    onOpenCoworker?: (input: { agentId: string; sessionId: string | null }) => void
    onOpenBox?: (spaceId: string) => void
    children?: ReactNode
    className?: string
}) {
    const plan = projectPlanCard(planSnapshot)
    const empty = messages.length === 0 && !error && !plan.view && !build

    return (
        <div className={cn('pointer-events-auto relative flex min-h-0 w-full flex-1 flex-col', className)}>
            <AnimatePresence>
                {emptyWelcome && empty && restored && <DesktopForemanWelcome key="welcome" thinking={streaming} />}
            </AnimatePresence>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-5 pt-24">
                <div className="mx-auto flex w-full max-w-xl flex-col justify-end gap-4 md:min-h-full">
                    {!restored && empty && (
                        <div aria-hidden className="flex flex-col gap-4">
                            <div className="h-3.5 w-1/2 animate-pulse rounded bg-muted" />
                            <div className="ml-auto h-16 w-40 animate-pulse rounded-lg bg-secondary" />
                            <div className="h-3.5 w-2/3 animate-pulse rounded bg-muted" />
                        </div>
                    )}
                    {messages.map(message => (
                        <div
                            key={message.id}
                            className={cn(
                                'max-w-[95%] rounded-lg px-4 py-3 text-sm',
                                message.role === 'user' ? 'ml-auto bg-secondary' : 'bg-transparent text-foreground',
                            )}
                        >
                            {message.text}
                            {message.docs?.map((part, index) => <DesktopForemanDocsTool key={index} part={part as import('ai').ToolUIPart} restored={restored} />)}
                        </div>
                    ))}
                    {plan.view && plan.revisionId && (
                        <DesktopPlanCard
                            plan={plan.view}
                            planRevisionId={plan.revisionId}
                            streaming={plan.streaming || !!streaming}
                            decision={plan.decision}
                            decisionStatus={decisionStatus}
                            onConfirm={onConfirmPlan}
                            onAskChanges={onAskChanges}
                            onRetryDecision={onRetryDecision}
                        />
                    )}
                    {build && (
                        <DesktopForemanBuildProgress build={build} onOpenCoworker={onOpenCoworker} onOpenBox={onOpenBox} onResume={onResumeBuild} onStop={onStopBuild} busy={buildBusy} />
                    )}
                    {nextSteps.length > 0 && !streaming && (
                        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.28 }}>
                            <DesktopForemanNextSteps
                                steps={nextSteps}
                                leadState={leadState}
                                onStartLead={onStartLead}
                                onOpenCreated={onOpenCreated}
                            />
                        </motion.div>
                    )}
                    {streaming && <p className="text-xs text-muted-foreground">Working…</p>}
                    {error && (
                        <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">
                            {error}
                        </div>
                    )}
                    {children}
                </div>
            </div>
        </div>
    )
}
