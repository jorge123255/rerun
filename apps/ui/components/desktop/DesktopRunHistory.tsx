'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { RunStatusBadge } from '@rerun/ui/monitoring'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { useVisibleInterval } from '@/hooks/useVisibleInterval'
import { desktopRunsSchema, recordedRunUsage, type DesktopRunView } from '@/lib/desktop/run-history'
import { fullDateTime } from '@/lib/time'
import type { DesktopAgentView } from './DesktopApp'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { ChevronRightIcon } from '@/lib/icons'
import { DesktopRunDetails } from './DesktopRunDetails'
import { useDesktopDialogControl, type DesktopDialogControl } from '@/lib/desktop/use-dialog-control'

function RecordedTime({ value, fallback = 'Not recorded' }: { value: string | null; fallback?: string }) {
    return value && Number.isFinite(Date.parse(value)) ? <time dateTime={value}>{fullDateTime(value)}</time> : <span>{fallback}</span>
}

function RunRow({ agentId, run }: { agentId: string; run: DesktopRunView }) {
    const [open, setOpen] = useState(false)
    return <li>
        <Collapsible open={open} onOpenChange={setOpen} className="overflow-hidden rounded-lg border">
            <CollapsibleTrigger className="group flex w-full flex-col gap-2 p-3 text-left hover:bg-accent/30">
                <div className="flex w-full flex-wrap items-center gap-2">
                    <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
                    <span className="min-w-0 flex-1 text-sm font-medium">Started <RecordedTime value={run.startedAt} /></span>
                    <RunStatusBadge status={run.status} />
                </div>
                <span className="text-xs text-muted-foreground">Finished <RecordedTime value={run.finishedAt} fallback={run.status === 'running' ? 'In progress' : 'Not recorded'} /></span>
                <span className="break-words text-xs text-muted-foreground">{run.stepCount} step{run.stepCount === 1 ? '' : 's'} · {recordedRunUsage(run)}</span>
                {(run.provider || run.model) && <span className="break-all text-xs text-muted-foreground">{[run.provider, run.model].filter(Boolean).join(' · ')}</span>}
            </CollapsibleTrigger>
            <CollapsibleContent>{open && <DesktopRunDetails agentId={agentId} runId={run.id} status={run.status} />}</CollapsibleContent>
        </Collapsible>
    </li>
}

function RunList({ agentId }: { agentId: string }) {
    const [runs, setRuns] = useState<DesktopRunView[] | null>(null)
    const [error, setError] = useState<string | null>(null)
    const read = useRef<AbortController | null>(null)
    const load = useCallback(async () => {
        if (read.current && !read.current.signal.aborted) return
        const controller = new AbortController()
        read.current = controller
        try {
            const response = await fetch(`/api/desktop/agents/${encodeURIComponent(agentId)}/runs`, { signal: controller.signal, cache: 'no-store' })
            if (!response.ok) throw new Error('Run history unavailable')
            const body = desktopRunsSchema.parse(await response.json())
            if (!controller.signal.aborted) { setRuns(body.runs); setError(null) }
        } catch {
            if (!controller.signal.aborted) setError('Could not load runs. The local engine may be unreachable. Try again.')
        } finally {
            if (read.current === controller) read.current = null
        }
    }, [agentId])
    useVisibleInterval(load, 3000)
    useEffect(() => () => read.current?.abort(), [])

    return <>
        {error && <div role="alert" className="shrink-0 text-sm text-destructive">{error}{runs && <p className="mt-1">Showing the last loaded runs.</p>}</div>}
        <div className="min-h-0 overflow-y-auto">
            {runs === null && !error ? <p role="status" className="py-6 text-sm text-muted-foreground">Loading runs…</p>
                : runs?.length === 0 && !error ? <p className="py-6 text-sm text-muted-foreground">No runs yet for this coworker.</p>
                : runs && <ul aria-label="Recent runs" className="space-y-3">
                    {runs.map(run => <RunRow key={run.id} agentId={agentId} run={run} />)}
                </ul>}
        </div>
        <DialogFooter className="shrink-0">
            <Button type="button" variant="outline" onClick={() => void load()}>{error ? 'Retry runs' : 'Refresh runs'}</Button>
            <DialogClose asChild><Button type="button">Done</Button></DialogClose>
        </DialogFooter>
    </>
}

export function DesktopRunHistory({ agent, dialogControl }: { agent: DesktopAgentView; dialogControl?: DesktopDialogControl }) {
    const [open, setOpen] = useDesktopDialogControl(dialogControl)
    return <Dialog open={open} onOpenChange={setOpen} asSheet={false}>
        <DialogTrigger asChild><Button type="button" variant="outline" size="sm">Runs</Button></DialogTrigger>
        <DialogContent className="flex max-h-[85dvh] flex-col sm:max-w-xl">
            <DialogHeader className="shrink-0">
                <DialogTitle>Recent runs</DialogTitle>
                <DialogDescription>Latest 50 runs for {agent.name}. Updates while this list is open.</DialogDescription>
            </DialogHeader>
            {open && <RunList key={agent.id} agentId={agent.id} />}
        </DialogContent>
    </Dialog>
}
