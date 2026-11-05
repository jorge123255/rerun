import { AGENT_TABS, type Tab } from '@/components/agent/agent-tabs'

// Only the coworker surfaces already mounted by the Mac. Keep upstream labels, descriptions,
// icons and rail order: Knowledge opens memories; Capabilities opens tools.
export const DESKTOP_COWORKER_PANELS = ['chat', 'actions', 'services', 'mcp', 'skills', 'memories', 'files', 'data', 'tools', 'scheduled', 'monitoring', 'logs', 'settings'] as const
export type DesktopCoworkerPanel = (typeof DESKTOP_COWORKER_PANELS)[number]

const supported = new Set<string>(DESKTOP_COWORKER_PANELS)
export function isDesktopCoworkerPanel(value: unknown): value is DesktopCoworkerPanel {
    return typeof value === 'string' && supported.has(value)
}

export const DESKTOP_COWORKER_PANEL_TABS = AGENT_TABS.filter((tab): tab is Tab & { id: DesktopCoworkerPanel } => isDesktopCoworkerPanel(tab.id))
