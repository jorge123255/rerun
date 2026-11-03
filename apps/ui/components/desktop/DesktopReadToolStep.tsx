'use client'

import type { DynamicToolUIPart, ToolUIPart } from 'ai'
import { ToolStepRow } from '@/components/chat/ToolStepRow'
import { getToolMeta } from '@/lib/tool-meta'

function readResult(output: unknown): { output?: string; errorText?: string } {
    if (typeof output === 'string') return { output }
    if (!output || typeof output !== 'object' || !('type' in output) || !('value' in output)) return {}
    // SDK history wraps the value which live tool events carry directly. Hosted tools store
    // errors as error-json, and local SDK execution stores them as error-text.
    if (output.type === 'error-json' || output.type === 'error-text') {
        const value = output.value
        if (typeof value === 'string') return { errorText: value }
        if (value && typeof value === 'object' && 'message' in value && typeof value.message === 'string') return { errorText: value.message }
        return { errorText: 'Could not read this file.' }
    }
    return typeof output.value === 'string' && (output.type === 'text' || output.type === 'json') ? { output: output.value } : {}
}

export function DesktopReadToolStep({ part }: { part: ToolUIPart | DynamicToolUIPart }) {
    const result = readResult(part.output)
    const errorText = part.errorText ?? result.errorText
    const display = getToolMeta('fs_read', part.input)
    return <ToolStepRow toolName="fs_read" label={display.label} iconProps={{ icon: display.icon }}
        state={errorText ? 'output-error' : part.state} input={part.input} output={errorText ? undefined : result.output} errorText={errorText} />
}
