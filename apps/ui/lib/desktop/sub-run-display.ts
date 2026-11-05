import type { ToolDisplay } from '@/hooks/useToolDisplay'
import { getToolMeta } from '@/lib/tool-meta'

export function desktopSubRunToolDisplay(toolName: string, input?: unknown): ToolDisplay {
    const meta = getToolMeta(toolName, input)
    return { label: meta.label, iconProps: { icon: meta.icon } }
}
