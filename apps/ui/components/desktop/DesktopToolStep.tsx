'use client'

import { getToolName, type DynamicToolUIPart, type ToolUIPart } from 'ai'
import { stripBridgePrefix } from '@rerun/contracts'
import { ToolStepRow } from '@/components/chat/ToolStepRow'
import { desktopToolPresentation } from '@/lib/desktop/tool-presentation'
import { getToolMeta } from '@/lib/tool-meta'
import { ranLabel } from '@/lib/chat/connector-tools'
import { desktopConnectorIconProps, resolveDesktopConnectorTool, type DesktopConnectorApps } from '@/lib/desktop/connector-apps'
import type { ToolIconProps } from '@/hooks/useToolDisplay'
import { redactHistoricalText } from './tool-presentations/redact'
import { projectDesktopToolStatus, type DesktopHistoricalContext } from './tool-presentations/status'
import { projectDesktopGenericTool } from './tool-presentations/plan'
import { DesktopHistoricalStepGroup } from './tool-presentations/DesktopHistoricalStepGroup'

/**
 * What a tool step is called and which mark it wears. A call that belongs to one of the coworker's
 * apps (`connectors`, read once per chat) takes the app's logo and a readable tool name; any other
 * call keeps the static tool map, exactly as before.
 */
export function desktopToolStepDisplay(toolName: string, input?: unknown, connectors?: DesktopConnectorApps): { icon: ToolIconProps['icon']; iconProps: ToolIconProps; label: string } {
    const display = getToolMeta(toolName === 'exec' ? 'shell_exec' : toolName === 'patch' ? 'fs_edit' : toolName)
    const connector = connectors ? resolveDesktopConnectorTool(toolName, connectors, input) : null
    if (connector) return { icon: display.icon, iconProps: desktopConnectorIconProps(connector.service), label: connector.label }
    // A connector tool that runs other tools by name (Composio) is named after what it ran.
    const ran = ranLabel(toolName, input)
    return { icon: display.icon, iconProps: { icon: display.icon }, label: ran ?? (toolName === 'functions.exec' ? 'Code mode' : display.label) }
}

export function DesktopToolStep({ part, restored, context, connectors }: { part: ToolUIPart | DynamicToolUIPart; restored: boolean; context?: DesktopHistoricalContext; connectors?: DesktopConnectorApps }) {
    const toolName = stripBridgePrefix(getToolName(part))
    const projected = restored && 'desktopPreview' in part && part.desktopPreview === true
    const fields = projected ? {
        input: part.input && typeof part.input === 'object' && 'preview' in part.input && typeof part.input.preview === 'string' ? { preview: redactHistoricalText(part.input.preview) } : undefined,
        output: typeof part.output === 'string' ? redactHistoricalText(part.output) : undefined,
        errorText: typeof part.errorText === 'string' ? redactHistoricalText(part.errorText) : undefined,
    } : desktopToolPresentation(toolName, part.input, part.output, part.errorText)
    const display = desktopToolStepDisplay(toolName, part.input, connectors)
    const status = projectDesktopToolStatus(part, context)
    if (status === 'pending' || status === 'cancelled' || status === 'unknown') {
        return <DesktopHistoricalStepGroup items={[projectDesktopGenericTool(part, 0, context)]} />
    }
    const state = fields.errorText ? 'output-error' : part.state === 'output-available' && part.preliminary ? 'input-available' : part.state
    return <ToolStepRow toolName={toolName} label={display.label} iconProps={display.iconProps} state={state} {...fields} />
}
