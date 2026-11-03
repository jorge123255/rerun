'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { desktopRunDetailsSchema, recordedToolOutcome, type DesktopRunDetailsView, type DesktopRunToolView } from '@/lib/desktop/run-details'
import type { DesktopRunView } from '@/lib/desktop/run-history'

function duration(ms: number) { return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s` }
function outcomeText(raw: string): string {
    try { return JSON.stringify(JSON.parse(raw), null, 2) } catch { return raw }
}

function ToolCalls({ tools }: { tools: DesktopRunToolView[] }) {
    return <ul className="space-y-2">
        {tools.map(tool => <li key={tool.id} className="rounded-md border p-2 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 break-all font-mono font-medium">{tool.toolName}</span>
                <span className={tool.isError !== 0 ? 'text-destructive' : 'text-muted-foreground'}>{recordedToolOutcome(tool)}</span>
            </div>
            {tool.durationMs !== null && <p className="mt-1 text-muted-foreground">{duration(tool.durationMs)}</p>}
            {tool.resultJson !== null && <details className="mt-2">
                <summary className="cursor-pointer py-1">Recorded outcome</summary>
                <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2">{outcomeText(tool.resultJson)}</pre>
            </details>}
        </li>)}
    </ul>
}

export function DesktopRunDetails({ agentId, runId, status }: { agentId: string; runId: string; status: DesktopRunView['status'] }) {
    const [result, setResult] = useState<{ detail?: DesktopRunDetailsView; error?: string } | null>(null)
    const [revision, setRevision] = useState(0)
    useEffect(() => {
        const controller = new AbortController()
        async function load() {
            try {
                const response = await fetch(`/api/desktop/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/details`, { signal: controller.signal, cache: 'no-store' })
                if (!response.ok) throw new Error(response.status === 404 ? 'Run not found for this coworker.' : 'Could not load run details. Try again.')
                const detail = desktopRunDetailsSchema.parse(await response.json())
                if (!controller.signal.aborted) setResult({ detail })
            } catch (error) {
                if (!controller.signal.aborted) setResult(current => ({ detail: current?.detail, error: error instanceof Error && error.message === 'Run not found for this coworker.' ? error.message : 'Could not load run details. Try again.' }))
            }
        }
        void load()
        return () => controller.abort()
    }, [agentId, runId, status, revision])
    const detail = result?.detail
    const stepNumbers = new Set(detail?.steps.map(step => step.stepNumber))
    const ungrouped = detail?.tools.filter(tool => !stepNumbers.has(tool.stepNumber)) ?? []

    return <div className="space-y-3 border-t px-3 pb-3 pt-2">
        {!result && <p role="status" className="text-xs text-muted-foreground">Loading run details…</p>}
        {result?.error && <div role="alert" className="text-xs text-destructive">{result.error}{detail && <p>Showing the last loaded details.</p>}</div>}
        {detail && (detail.steps.length === 0 && detail.tools.length === 0 ? <p className="text-xs text-muted-foreground">No steps or tool calls recorded for this run.</p> : <>
            {detail.steps.length === 0 && <p className="text-xs text-muted-foreground">No steps recorded for this run.</p>}
            {detail.steps.map(step => <section key={step.id} aria-label={`Step ${step.stepNumber}`} className="space-y-2">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                    <h3 className="font-medium">Step {step.stepNumber}</h3>
                    <span className="break-all text-muted-foreground">{step.finishReason ? `Finish reason: ${step.finishReason}` : 'Outcome not recorded'}</span>
                    {step.totalTokens !== null && <span className="text-muted-foreground">{step.totalTokens.toLocaleString()} tokens</span>}
                    {step.durationMs !== null && <span className="text-muted-foreground">{duration(step.durationMs)}</span>}
                </div>
                <ToolCalls tools={detail.tools.filter(tool => tool.stepNumber === step.stepNumber)} />
            </section>)}
            {detail.tools.length === 0 && <p className="text-xs text-muted-foreground">No tool calls recorded for this run.</p>}
            {ungrouped.length > 0 && <section aria-label="Tool calls without a recorded step" className="space-y-2">
                <h3 className="text-xs font-medium">Tool calls without a recorded step</h3><ToolCalls tools={ungrouped} />
            </section>}
        </>)}
        {result && <Button type="button" variant="outline" size="sm" onClick={() => setRevision(value => value + 1)}>{result.error ? 'Retry details' : 'Refresh details'}</Button>}
    </div>
}
