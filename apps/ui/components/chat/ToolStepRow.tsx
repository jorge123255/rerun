'use client'

import { ElapsedTime } from '@/components/chat/ElapsedTime'
import { StepRow } from '@/components/chat/StepRow'
import type { ToolDisplay } from '@/hooks/useToolDisplay'
import { argsOf, toolHeadline } from '@/lib/chat/tool-headline'
import { cn } from '@/lib/utils'
import type { ToolCallStatus } from '@rerun/ui/chat'

export type ToolState = 'input-streaming' | 'input-available' | 'output-available' | 'output-error' | 'output-denied' | 'approval-requested' | 'approval-responded'

export type ToolCallBlockProps = {
    toolName: string
    agentId?: string
    state: ToolState
    input?: unknown
    inputText?: string
    output?: unknown
    errorText?: string
}

export function toolStatusOf(state: ToolState): ToolCallStatus {
    switch (state) {
        case 'output-available':
            return 'done'
        case 'output-error':
        case 'output-denied':
            return 'error'
        default:
            return 'running'
    }
}

export const hasDetails = ({ input, inputText, output, errorText }: ToolCallBlockProps) => Object.keys(argsOf(input) ?? {}).length > 0 || output !== undefined || !!inputText || !!errorText

/** A tool call on one line of the folded steps, with its input and result available on click. */
export function ToolStepRow({ label, iconProps, targetAgentName, ...props }: ToolCallBlockProps & ToolDisplay & { targetAgentName?: string }) {
    const status = toolStatusOf(props.state)
    return (
        <StepRow
            iconProps={iconProps}
            label={label}
            detail={status === 'error' && props.errorText ? props.errorText : toolHeadline(props.input, targetAgentName)}
            status={status}
            elapsed={<ElapsedTime active={status === 'running'} className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground/70" />}
        >
            {hasDetails(props) && <ToolCallDetails {...props} />}
        </StepRow>
    )
}

export function ToolCallDetails({ toolName, state, input, inputText, output, errorText }: ToolCallBlockProps) {
    const args = argsOf(input)
    return (
        <>
            {state === 'input-streaming' && inputText && (
                <ToolSection label="Input">
                    <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-background px-2 py-1.5 text-xs font-mono text-foreground opacity-60">{inputText}</pre>
                </ToolSection>
            )}
            {args && Object.keys(args).length > 0 && (
                <ToolSection label="Input">
                    <ToolArgs args={args} toolName={toolName} />
                </ToolSection>
            )}
            {errorText && (
                <ToolSection label="Error">
                    <p className="rounded bg-red-950/20 px-2 py-1.5 text-xs text-red-400">{errorText}</p>
                </ToolSection>
            )}
            {output !== undefined && (
                <ToolSection label="Output">
                    <ToolOutput output={output} />
                </ToolSection>
            )}
        </>
    )
}

export function ToolSection({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div>
            <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
            <div className="mt-0.5">{children}</div>
        </div>
    )
}

function ToolArgs({ args, toolName }: { args: Record<string, unknown>; toolName: string }) {
    if (typeof args.preview === 'string' && Object.keys(args).length <= 1) {
        return <code className="block whitespace-pre-wrap break-all rounded bg-background px-2 py-1.5 text-xs font-mono text-foreground">{args.preview}</code>
    }

    if (toolName === 'shell_exec' && typeof args.command === 'string') {
        return <code className="block whitespace-pre-wrap break-all rounded bg-background px-2 py-1.5 text-xs font-mono text-foreground">{args.command}</code>
    }

    if (/^(fs|shared)_(read|write|edit|list|search)$/.test(toolName) && typeof args.path === 'string') {
        return <code className="block whitespace-pre-wrap break-all rounded bg-background px-2 py-1.5 text-xs font-mono text-foreground">{args.path}</code>
    }

    return <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-background px-2 py-1.5 text-xs font-mono text-foreground">{JSON.stringify(args, null, 2)}</pre>
}

export function ToolOutput({ output }: { output: unknown }) {
    if (output && typeof output === 'object' && 'duration' in output && Object.keys(output).length === 1) {
        const duration = (output as { duration?: number }).duration
        if (typeof duration === 'number') {
            return <span className="text-xs text-muted-foreground">Completed in {duration < 1 ? `${Math.round(duration * 1000)}ms` : `${duration.toFixed(1)}s`}</span>
        }
    }

    const text = typeof output === 'string' ? output : JSON.stringify(output, null, 2)
    const truncated = text.length > 2000

    return (
        <pre className={cn(
            'max-h-60 overflow-auto whitespace-pre-wrap break-all rounded bg-background px-2 py-1.5 text-xs font-mono text-foreground',
            truncated && 'relative after:absolute after:inset-x-0 after:bottom-0 after:h-8 after:bg-linear-to-t after:from-background after:to-transparent'
        )}>
            {truncated ? text.slice(0, 2000) + '…' : text}
        </pre>
    )
}
