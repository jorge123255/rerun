'use client'

import { getToolName, type DynamicToolUIPart, type ToolUIPart } from 'ai'
import { stripBridgePrefix } from '@rerun/contracts'
import { ToolStepRow } from '@/components/chat/ToolStepRow'
import { desktopToolPresentation } from '@/lib/desktop/tool-presentation'
import { getToolMeta } from '@/lib/tool-meta'
import { redactHistoricalText } from './tool-presentations/redact'
import { projectDesktopToolStatus, type DesktopHistoricalContext } from './tool-presentations/status'
import { planDesktopToolPresentation } from './tool-presentations/plan'
import { DesktopHistoricalStepGroup } from './tool-presentations/DesktopHistoricalStepGroup'

export function DesktopToolStep({ part, restored, context }: { part: ToolUIPart | DynamicToolUIPart; restored: boolean; context?: DesktopHistoricalContext }) {
    const toolName = stripBridgePrefix(getToolName(part))
    const projected = restored && 'desktopPreview' in part && part.desktopPreview === true
    const fields = projected ? {
        input: part.input && typeof part.input === 'object' && 'preview' in part.input && typeof part.input.preview === 'string' ? { preview: redactHistoricalText(part.input.preview) } : undefined,
        output: typeof part.output === 'string' ? redactHistoricalText(part.output) : undefined,
        errorText: typeof part.errorText === 'string' ? redactHistoricalText(part.errorText) : undefined,
    } : desktopToolPresentation(toolName, part.input, part.output, part.errorText)
    const display = getToolMeta(toolName === 'exec' ? 'shell_exec' : toolName === 'patch' ? 'fs_edit' : toolName)
    const status = projectDesktopToolStatus(part, context)
    if (status === 'pending' || status === 'cancelled' || status === 'unknown') {
        const block = planDesktopToolPresentation([part], context).find(block => block.kind === 'group')
        if (block?.kind === 'group') return <DesktopHistoricalStepGroup items={block.items} />
    }
    const state = fields.errorText ? 'output-error' : part.state === 'output-available' && part.preliminary ? 'input-available' : part.state
    return <ToolStepRow toolName={toolName} label={toolName === 'functions.exec' ? 'Code mode' : display.label} iconProps={{ icon: display.icon }} state={state} {...fields} />
}
