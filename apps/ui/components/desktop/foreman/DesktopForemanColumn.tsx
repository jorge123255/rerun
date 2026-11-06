'use client'

import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import type { ForemanAnchor, OrbActivity } from '@rerun/ui/foreman'
import { cn } from '@/lib/utils'
import type { DesktopForemanActionPorts, DesktopForemanChatRef, DesktopForemanPlacement } from '@/lib/desktop/foreman-client'
import { DesktopForemanChatLayer, type DesktopForemanMessage } from './DesktopForemanChatLayer'
import { DesktopForemanComposer } from './DesktopForemanComposer'
import { DesktopForemanHeader } from './DesktopForemanHeader'
import { DesktopForemanRoutines } from './DesktopForemanRoutines'
import { DesktopPlanBoardPreview } from './plan/DesktopPlanBoardPreview'
import { projectPlanCard } from '@/lib/desktop/foreman-client'
import { useDesktopForemanUi } from './useDesktopForemanUi'

function anchorOf(placement: DesktopForemanPlacement): ForemanAnchor {
    if (placement.mode === 'float') return 'float'
    return placement.side === 'left' ? 'dock-left' : 'dock-right'
}

export type DesktopForemanColumnProps = {
    chat: DesktopForemanChatRef
    ports: DesktopForemanActionPorts
    live: { runId: string } | null
    messages: DesktopForemanMessage[]
    streaming?: boolean
    agentNameOf: (agentId: string) => string
    orbState?: OrbActivity
    headerActions?: ReactNode
    /** Root mounts discoveries on the board; receives live overlay state. */
    renderBoardOverlay?: (input: { discoveries: import('@/lib/desktop/foreman-client').DesktopDiscoveriesState; live: boolean }) => ReactNode
    className?: string
    onClose?: () => void
    openOnMount?: boolean
    refreshKey?: string | number
    composerTrailing?: ReactNode
}

/**
 * Desktop Foreman column. Board stays visible behind/beside it; root mounts this package and
 * supplies conversation / model / voice / persistence adapters. Deliberate open/close only.
 */
export function DesktopForemanColumn({
    chat,
    ports,
    live,
    messages,
    streaming,
    agentNameOf,
    orbState = 'idle',
    headerActions,
    renderBoardOverlay,
    className, onClose, openOnMount, refreshKey, composerTrailing,
}: DesktopForemanColumnProps) {
    const foreman = useDesktopForemanUi({ chat, ports, live, initialOpen: true, refreshKey, onClose })
    const opened = useRef(false)
    useEffect(() => {
        if (openOnMount && foreman.restored && !opened.current) { opened.current = true; foreman.setOpen(true) }
    }, [openOnMount, foreman.restored, foreman.setOpen])
    const { ui } = foreman
    const onRoutines = ui.tab === 'routines'
    const plan = projectPlanCard(foreman.planSnapshot)
    const docked = ui.placement.mode === 'dock'
    const floating = ui.placement.mode === 'float'

    const panelStyle = useMemo(() => {
        if (!floating) return undefined
        return { width: ui.placement.width, height: ui.placement.height } as const
    }, [floating, ui.placement])

    return (
        <div
            {...(!ui.open ? { inert: true } : {})}
            style={panelStyle}
            className={cn(
                'absolute inset-0 z-50 min-w-0 overflow-hidden transition-transform duration-300 ease-in-out motion-reduce:transition-none max-md:top-auto md:translate-y-0',
                'max-md:max-h-[calc(96dvh-env(safe-area-inset-top))] max-md:rounded-t-2xl max-md:border-t max-md:border-border max-md:shadow-2xl',
                !ui.open && 'translate-y-full',
                floating
                    ? cn('md:fixed md:inset-auto md:z-50 md:overflow-visible md:rounded-xl md:border md:border-border md:shadow-2xl', !ui.open && 'md:pointer-events-none md:scale-95 md:opacity-0')
                    : cn('md:relative md:inset-auto md:z-auto md:row-start-1 md:block', ui.placement.mode === 'dock' && ui.placement.side === 'left' ? 'md:col-start-1' : 'md:col-start-3'),
                className,
            )}
        >
            <div
                className={cn(
                    'absolute inset-y-0 flex w-full flex-col bg-background',
                    floating
                        ? 'right-0 md:inset-x-0 md:overflow-hidden md:rounded-xl md:border md:border-border md:shadow-2xl'
                        : cn('md:w-[calc(var(--foreman-dock-track,26rem)-8px)] md:overflow-hidden md:rounded-3xl md:border md:border-border md:shadow', ui.placement.mode === 'dock' && ui.placement.side === 'left' ? 'left-0' : 'right-0'),
                )}
            >
                <DesktopForemanHeader
                    anchor={anchorOf(ui.placement)}
                    orbState={orbState}
                    open={ui.open}
                    tab={ui.tab}
                    onTabChange={foreman.setTab}
                    onClose={() => foreman.setOpen(false)}
                    actions={headerActions}
                />
                <div className={onRoutines ? 'hidden' : 'contents'}>
                    <DesktopForemanChatLayer
                        messages={messages}
                        streaming={streaming}
                        restored={foreman.restored}
                        emptyWelcome
                        planSnapshot={foreman.planSnapshot}
                        decisionStatus={ui.decision}
                        build={foreman.build}
                        nextSteps={foreman.nextSteps}
                        leadState={foreman.leadState}
                        live={foreman.live}
                        error={foreman.error || (foreman.blocked ? `Blocked: ${foreman.blocked.replaceAll('_', ' ')}` : null)}
                        onConfirmPlan={foreman.confirmPlan}
                        onAskChanges={() => foreman.askChanges()}
                        onRetryDecision={foreman.retryDecision}
                        onStartLead={foreman.startLead}
                        onOpenCreated={step => foreman.navigate({ kind: 'open_coworker', agentId: step.agentId, sessionId: step.sessionId })}
                        onOpenCoworker={input => foreman.navigate({ kind: 'open_coworker', agentId: input.agentId, sessionId: input.sessionId })}
                        onOpenBox={spaceId => foreman.navigate({ kind: 'open_box', spaceId })}
                        className="min-h-0 flex-1"
                    />
                    <DesktopForemanComposer
                        trailing={composerTrailing}
                        draft={ui.draft}
                        onDraftChange={foreman.setDraft}
                        busy={!!streaming}
                        disabled={!foreman.restored || !!foreman.blocked || ui.decision.status === 'pending'}
                        onSend={text => { void foreman.sendMessage(text) }}
                        onStop={() => void foreman.stop()}
                    />
                </div>
                {onRoutines && (
                    <DesktopForemanRoutines
                        key={`${chat.workspaceId}:${chat.chatId}`}
                        routines={ports.routines}
                        docked={docked}
                        agentNameOf={agentNameOf}
                        className="min-h-0 flex-1 pt-24"
                        onOpenRoutine={routine => foreman.navigate({ kind: 'open_coworker', agentId: routine.agentId, sessionId: routine.runningSessionId ?? null })}
                    />
                )}
            </div>
            {/* Board-side plan preview host: root may also mirror plan via setPlanPreview. */}
            {renderBoardOverlay?.({ discoveries: foreman.discoveries, live: foreman.live })}
            {plan.view && (
                <div className="pointer-events-none absolute inset-0 -z-10 hidden opacity-0" aria-hidden>
                    <DesktopPlanBoardPreview plan={plan.view} />
                </div>
            )}
        </div>
    )
}
