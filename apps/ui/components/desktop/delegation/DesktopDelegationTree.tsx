'use client'

import { TextShimmer } from '@rerun/ui'
import { Badge, ScrollFade } from '@rerun/ui/primitives'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState, type ReactNode } from 'react'

import { StepGlyph } from '@/components/chat/StepRow'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { IconBadge } from '@/components/ui/icon-badge'
import { Skeleton } from '@/components/ui/skeleton'
import { formatElapsed } from '@/hooks/useElapsed'
import type { ToolDisplay } from '@/hooks/useToolDisplay'
import { stripBridgePrefix } from '@/lib/chat/bridge-name'
import { isSubRunFailing, isSubRunLive, isSubRunStalled, type SubRunCall, type SubRunTask } from '@/lib/chat/sub-run-progress'
import { CheckIcon, ChevronRightIcon, ClockIcon, SquareIcon, XIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { DesktopDelegationTask } from '@rerun/contracts'
import { delegationDetail, delegationOutcome, delegationTaskToSubRun } from './task-view'

type ToolDisplayOf = (toolName: string) => ToolDisplay
type Tone = 'brand' | 'green' | 'red' | 'muted'

const BRANCH_TONE: Record<Tone, string> = {
    brand: 'border-brand/70',
    green: 'border-emerald-400/70',
    red: 'border-red-400/70',
    muted: 'border-border',
}

const VISIBLE_LIVE_CALLS = 3

const STEP_VERBS: Record<string, string> = {
    web_search: 'Searching',
    web_fetch: 'Reading',
    browser_navigate: 'Browsing',
    shell_exec: 'Running',
    fs_read: 'Reading',
    fs_write: 'Writing',
    fs_edit: 'Editing',
}

const EASE = [0.4, 0, 0.2, 1] as const

function toneOf(task: SubRunTask): Tone {
    if (task.status === 'running') return isSubRunFailing(task) ? 'red' : 'brand'
    if (task.status === 'done' || task.status === 'dispatched') return 'green'
    if (task.status === 'error') return 'red'
    return 'muted'
}

const settledSeconds = (task: SubRunTask) => (task.startedAt === undefined || task.finishedAt === undefined ? undefined : Math.max(0, (task.finishedAt - task.startedAt) / 1000))

export type DesktopDelegationTreeProps = {
    tasks: readonly DesktopDelegationTask[]
    toolDisplay: ToolDisplayOf
    onStopTask?: (taskId: string) => Promise<void>
}

/** Ordered task branches. Stop stays enabled after a failed attempt. */
export function DesktopDelegationTree({ tasks, toolDisplay, onStopTask }: DesktopDelegationTreeProps) {
    return (
        <div className="@container flex flex-col gap-1 px-1 pt-1 pb-1">
            {tasks.map((task, index) => (
                <TaskBranch key={task.taskId} task={task} last={index === tasks.length - 1} toolDisplay={toolDisplay} onStop={onStopTask} />
            ))}
        </div>
    )
}

function Branch({ tone, last, children, className }: { tone: Tone; last: boolean; children: ReactNode; className?: string }) {
    return (
        <div className={cn('relative pl-6', className)}>
            {!last && <span aria-hidden className={cn('absolute top-0 -bottom-1 left-2.5 border-l transition-colors duration-500', BRANCH_TONE[tone])} />}
            <span aria-hidden className={cn('absolute top-0 left-2.5 h-3.5 w-3 rounded-bl-md border-b border-l transition-colors duration-500', BRANCH_TONE[tone])} />
            {children}
        </div>
    )
}

function TaskStatus({ task, reconcile }: { task: SubRunTask; reconcile?: boolean }) {
    if (reconcile) return <IconBadge tone="neutral" icon={ClockIcon} glow={false} />
    if (task.status === 'running') return <IconBadge tone={isSubRunFailing(task) ? 'red' : 'brand'} animated glow={false} />
    if (task.status === 'error') return <IconBadge tone="red" icon={XIcon} glow={false} />
    if (task.status === 'stopped') return <IconBadge tone="neutral" icon={SquareIcon} glow={false} />
    if (task.status === 'queued') return <IconBadge tone="neutral" icon={ClockIcon} glow={false} />
    return <IconBadge tone="green" icon={CheckIcon} glow={false} />
}

function TaskBranch({ task, last, toolDisplay, onStop }: { task: DesktopDelegationTask; last: boolean; toolDisplay: ToolDisplayOf; onStop?: (taskId: string) => Promise<void> }) {
    const view = delegationTaskToSubRun(task)
    const outcome = delegationOutcome(task)
    const detail = delegationDetail(task)
    const [open, setOpen] = useState(false)
    const [stopping, setStopping] = useState(false)
    const [error, setError] = useState('')
    const alive = useRef(true)
    const tone = outcome?.kind === 'reconcile' ? 'muted' : toneOf(view)
    const running = view.status === 'running'
    const settled = !isSubRunLive(view)
    const expandable = settled && (!!view.calls?.length || !!detail)
    const seconds = settled ? settledSeconds(view) : undefined
    const idleMinutes = view.idleMs === undefined ? undefined : Math.floor(view.idleMs / 60_000)
    // A Stop that already marked the task stopped can still have unconfirmed cleanup. That attempt stays retryable.
    const cleanupUnconfirmed = task.cleanup === 'blocked' || (view.status === 'stopped' && task.cleanup !== 'complete')
    const canStop = !!onStop && (view.status === 'queued' || running || cleanupUnconfirmed)

    useEffect(() => {
        alive.current = true
        return () => { alive.current = false }
    }, [])

    useEffect(() => {
        if (!running && task.cleanup === 'complete') setError('')
    }, [running, task.cleanup])

    return (
        <div data-task-id={task.taskId} className="min-w-0">
        <Branch tone={tone} last={last}>
            <Collapsible open={open && expandable} onOpenChange={setOpen}>
                <div className="flex items-center gap-1">
                    <CollapsibleTrigger
                        disabled={!expandable}
                        className="group flex h-7 min-w-0 flex-1 items-center gap-2.5 rounded-md pr-1 text-left text-sm transition-colors enabled:hover:bg-muted/50"
                    >
                        <TaskStatus task={view} reconcile={outcome?.kind === 'reconcile'} />
                        <span className={cn('min-w-0 flex-1 truncate font-medium', view.status === 'queued' && 'text-muted-foreground')}>{view.title}</span>
                        {isSubRunFailing(view) && (
                            <Badge tone="red" size="xs" glow={false} className="hidden @md:inline-flex">
                                {view.failures} failures in a row
                            </Badge>
                        )}
                        {isSubRunStalled(view) && idleMinutes !== undefined && (
                            <Badge tone="orange" size="xs" glow={false} className="hidden @md:inline-flex">
                                Idle {idleMinutes} min
                            </Badge>
                        )}
                        {seconds !== undefined && <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">{formatElapsed(seconds)}</span>}
                        <ChevronRightIcon className={cn('size-3 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90', !expandable && 'invisible')} />
                    </CollapsibleTrigger>
                    {canStop && (
                        <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label="Stop this task"
                            disabled={stopping}
                            className="-my-1 size-7 shrink-0 text-muted-foreground"
                            onClick={event => {
                                event.stopPropagation()
                                // The shared SubRunTree latch stays off after one click. This one releases on failure.
                                setStopping(true)
                                setError('')
                                void Promise.resolve(onStop!(view.id!)).then(() => {
                                    if (alive.current) setStopping(false)
                                }, cause => {
                                    if (!alive.current || (cause instanceof Error && cause.name === 'AbortError')) return
                                    setStopping(false)
                                    setError(cause instanceof Error && cause.message ? cause.message : 'Delegation unavailable or changed. Refresh and retry Stop.')
                                })
                            }}
                        >
                            <SquareIcon className="size-3" />
                        </Button>
                    )}
                </div>

                {running && <LiveSteps task={view} tone={tone} toolDisplay={toolDisplay} />}
                {settled && !open && <Outcome task={task} />}
                {error && <p role="alert" className="pb-1 pl-0.5 text-xs break-words text-red-500">{error}</p>}

                {expandable && (
                    <CollapsibleContent>
                        <div className="flex flex-col gap-1.5 pt-1 pb-1">
                            {!!view.calls?.length && (
                                <div className="flex flex-col">
                                    {view.calls.map((call, index) => (
                                        <StepLine key={index} call={call} tone={tone} last={index === view.calls!.length - 1} toolDisplay={toolDisplay} />
                                    ))}
                                </div>
                            )}
                            <Outcome task={task} />
                            {detail && (
                                <div className="ml-6 rounded-md bg-muted/40">
                                    <ScrollFade className="max-h-40" fadeSize={32}>
                                        <p className="px-2.5 py-2 text-xs whitespace-pre-wrap break-words text-foreground/80">{detail}</p>
                                    </ScrollFade>
                                </div>
                            )}
                        </div>
                    </CollapsibleContent>
                )}
            </Collapsible>
        </Branch>
        </div>
    )
}

function Outcome({ task }: { task: DesktopDelegationTask }) {
    const outcome = delegationOutcome(task)
    if (!outcome) return null
    if (outcome.kind === 'reconcile') {
        return (
            <p data-outcome="reconcile" className="flex h-6 min-w-0 items-center gap-2.5 pl-0.5 text-xs text-muted-foreground">
                <span className="truncate">{outcome.text}</span>
            </p>
        )
    }
    if (outcome.kind === 'success' || outcome.kind === 'empty-result') {
        return (
            <p data-outcome={outcome.kind} className="flex h-6 min-w-0 items-center gap-2.5 pl-0.5 text-xs text-emerald-600 dark:text-emerald-400">
                <CheckIcon className="size-3.5 shrink-0" />
                <span className="truncate">{outcome.text}</span>
            </p>
        )
    }
    return (
        <p data-outcome={outcome.kind} className={cn('flex h-6 min-w-0 items-center gap-2.5 pl-0.5 text-xs', outcome.kind === 'error' ? 'text-red-500 dark:text-red-400' : 'text-muted-foreground')}>
            {outcome.kind === 'error' ? <XIcon className="size-3.5 shrink-0" /> : <SquareIcon className="size-3 shrink-0" />}
            <span className="truncate">{outcome.text}</span>
        </p>
    )
}

function liveCalls(task: SubRunTask): SubRunCall[] {
    if (task.calls?.length) return task.calls
    if (!task.activity) return []
    const call: SubRunCall = { tool: task.activity, summary: '' }
    if (task.idleMs !== undefined) call.elapsedMs = task.idleMs
    return [call]
}

function LiveSteps({ task, tone, toolDisplay }: { task: SubRunTask; tone: Tone; toolDisplay: ToolDisplayOf }) {
    const calls = liveCalls(task)
    const total = task.calls?.length ? Math.max(task.toolCalls ?? 0, calls.length) : calls.length
    const visible = calls.slice(-VISIBLE_LIVE_CALLS)
    const hidden = total - visible.length
    const inFlight = calls.some(call => call.elapsedMs !== undefined)

    return (
        <div className="flex flex-col">
            {hidden > 0 && <div className="flex h-6 items-center pl-6 text-[11px] text-muted-foreground/70">+{hidden} earlier</div>}
            <AnimatePresence initial={false}>
                {visible.map((call, index) => (
                    <motion.div
                        key={total - visible.length + index}
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.25, ease: EASE }}
                    >
                        <StepLine call={call} tone={tone} last={inFlight && index === visible.length - 1} toolDisplay={toolDisplay} />
                    </motion.div>
                ))}
            </AnimatePresence>
            {!inFlight && (
                <Branch tone={tone} last className="opacity-60">
                    <div className="flex h-6 items-center gap-2.5">
                        <span className="size-3.5 shrink-0 rounded-full border border-dashed border-muted-foreground/50" />
                        <Skeleton className="h-2 w-32 max-w-[60%] rounded-full" />
                    </div>
                </Branch>
            )}
        </div>
    )
}

function StepLine({ call, tone, last, toolDisplay }: { call: SubRunCall; tone: Tone; last: boolean; toolDisplay: ToolDisplayOf }) {
    const tool = stripBridgePrefix(call.tool)
    const display = toolDisplay(tool)
    const current = call.elapsedMs !== undefined
    const label = `${STEP_VERBS[tool] ?? display.label} ${call.summary}`.trim()
    return (
        <Branch tone={call.failed ? 'red' : tone} last={last}>
            <div className={cn('flex h-6 min-w-0 items-center gap-2.5 text-xs', call.failed ? 'text-red-500 dark:text-red-400' : 'text-muted-foreground')}>
                {call.failed ? <XIcon className="size-3.5 shrink-0" /> : <StepGlyph iconProps={display.iconProps} />}
                <span className="min-w-0 flex-1 truncate">{current ? <TextShimmer className="block truncate text-xs">{label}</TextShimmer> : label}</span>
                {call.failed && <span className="shrink-0">Failed</span>}
            </div>
        </Branch>
    )
}
