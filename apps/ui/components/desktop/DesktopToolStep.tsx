'use client'

import { getToolName, type DynamicToolUIPart, type ToolUIPart } from 'ai'
import { stripBridgePrefix } from '@rerun/contracts'
import { ToolStepRow } from '@/components/chat/ToolStepRow'
import { desktopToolPresentation } from '@/lib/desktop/tool-presentation'
import { getToolMeta } from '@/lib/tool-meta'

export function DesktopToolStep({ part, restored }: { part: ToolUIPart | DynamicToolUIPart; restored: boolean }) {
    const toolName = stripBridgePrefix(getToolName(part))
    const projected = restored && 'desktopPreview' in part && part.desktopPreview === true
    const fields = projected ? {
        input: part.input && typeof part.input === 'object' && 'preview' in part.input && typeof part.input.preview === 'string' ? { preview: part.input.preview } : undefined,
        output: typeof part.output === 'string' ? part.output : undefined,
        errorText: part.errorText,
    } : desktopToolPresentation(toolName, part.input, part.output, part.errorText)
    const display = getToolMeta(toolName === 'exec' ? 'shell_exec' : toolName === 'patch' ? 'fs_edit' : toolName)
    const state = fields.errorText ? 'output-error' : part.state === 'output-available' && part.preliminary ? 'input-available' : part.state
    return <ToolStepRow toolName={toolName} label={toolName === 'functions.exec' ? 'Code mode' : display.label} iconProps={{ icon: display.icon }} state={state} {...fields} />
}
