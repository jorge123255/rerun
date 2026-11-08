import type { ToolSet } from 'ai'
import { FOREMAN_AGENT_ID } from '@rerun/contracts'

const identities = new WeakMap<object, string>()
const names = new Set(['show_plan', 'open_panel', 'read_company', 'search_docs', 'agent_files_read', 'agent_files_list', 'agent_files_search', 'agent_files_write', 'agent_files_edit'])

export function registerDesktopForemanTools(tools: ToolSet): ToolSet {
    for (const [name, tool] of Object.entries(tools)) if (names.has(name)) identities.set(tool, name)
    return tools
}

export function isDesktopForemanTool(value: unknown, name: string, agentId: string, kind: string | undefined): boolean {
    return agentId === FOREMAN_AGENT_ID && kind === 'foreman' && !!value && typeof value === 'object' && identities.get(value) === name
}
