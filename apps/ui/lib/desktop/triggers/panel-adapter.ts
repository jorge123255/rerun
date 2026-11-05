/**
 * B5 / Control Center Open → Triggers adapter.
 * Root wires this into coworker panel navigation once `triggers` is added to DESKTOP_COWORKER_PANELS.
 * This lane does not edit DesktopApp, ControlCenter, or coworker-panel.ts.
 */

export const DESKTOP_TRIGGERS_PANEL_ID = 'triggers' as const

export type DesktopTriggersPanelCommand = {
    id: typeof DESKTOP_TRIGGERS_PANEL_ID
    label: 'Triggers'
    keywords: string[]
    description: string
}

export const desktopTriggersPanelCommand: DesktopTriggersPanelCommand = {
    id: DESKTOP_TRIGGERS_PANEL_ID,
    label: 'Triggers',
    keywords: ['webhook', 'trigger', 'url', 'http', 'ingress'],
    description: 'Public URLs that start a run when called',
}

export type OpenDesktopTriggersPanel = (agentId: string) => void

export function createDesktopTriggersOpenCommand(open: OpenDesktopTriggersPanel) {
    return {
        ...desktopTriggersPanelCommand,
        run: (agentId: string) => open(agentId),
    }
}
