export const DESKTOP_OVERVIEW_VIEWS = {
    apps: ['services', 'mcp'],
    skills: ['skills'],
    knowledge: ['memories'],
    files: ['files', 'published'],
    data: ['data'],
    routines: ['scheduled', 'triggers'],
    activity: ['monitoring', 'logs'],
    settings: ['settings', 'tools', 'setup'],
} as const

export type DesktopOverviewView = keyof typeof DESKTOP_OVERVIEW_VIEWS
export type DesktopOverviewTab = (typeof DESKTOP_OVERVIEW_VIEWS)[DesktopOverviewView][number]

export const DESKTOP_OVERVIEW_TILES = ['services', 'skills', 'memories', 'scheduled'] as const
export const DESKTOP_OVERVIEW_ROWS = ['files', 'data'] as const
export const DESKTOP_OVERVIEW_FOOTER = ['monitoring', 'settings'] as const

export type DesktopOverviewDestination = (typeof DESKTOP_OVERVIEW_TILES)[number] | (typeof DESKTOP_OVERVIEW_ROWS)[number] | (typeof DESKTOP_OVERVIEW_FOOTER)[number]

const VIEW_LABELS: Record<DesktopOverviewView, string> = {
    apps: 'Apps', skills: 'Skills', knowledge: 'Knowledge', files: 'Files', data: 'Database', routines: 'Routines', activity: 'Activity', settings: 'Settings',
}

const TAB_LABELS: Record<DesktopOverviewTab, string> = {
    services: 'Apps', mcp: 'MCP', skills: 'Skills', memories: 'Knowledge', files: 'Files', published: 'Published', data: 'Database', scheduled: 'Scheduled', triggers: 'Triggers', monitoring: 'Monitoring', logs: 'Logs', settings: 'General', tools: 'Capabilities', setup: 'Install',
}

const CARD_LABELS: Record<DesktopOverviewDestination, string> = {
    services: 'Apps',
    skills: 'Skills',
    memories: 'Knowledge',
    scheduled: 'Routines',
    files: 'Files',
    data: 'Database',
    monitoring: 'Activity',
    settings: 'Settings',
}

export function desktopOverviewDestinationLabel(tab: DesktopOverviewDestination) {
    return CARD_LABELS[tab]
}

export function desktopOverviewViewLabel(view: DesktopOverviewView) {
    return VIEW_LABELS[view]
}

export function desktopOverviewTabLabel(tab: DesktopOverviewTab) {
    return TAB_LABELS[tab]
}

const VIEW_OF_TAB = Object.fromEntries((Object.entries(DESKTOP_OVERVIEW_VIEWS) as [DesktopOverviewView, readonly DesktopOverviewTab[]][]).flatMap(([view, tabs]) => tabs.map(tab => [tab, view]))) as Record<DesktopOverviewTab, DesktopOverviewView>

export function desktopOverviewViewOf(tab: DesktopOverviewTab) {
    return VIEW_OF_TAB[tab]
}

export type DesktopOverviewVisibility = { installAuthor: boolean; publishedAccess: boolean }

export function desktopOverviewTabHidden(tab: DesktopOverviewTab, visibility: DesktopOverviewVisibility) {
    return (tab === 'setup' && !visibility.installAuthor) || (tab === 'published' && !visibility.publishedAccess)
}

export function desktopOverviewSiblingTabs(tab: DesktopOverviewTab, visibility: DesktopOverviewVisibility): DesktopOverviewTab[] {
    return DESKTOP_OVERVIEW_VIEWS[desktopOverviewViewOf(tab)].filter(id => !desktopOverviewTabHidden(id, visibility))
}

export function shownDesktopOverviewTab(tab: DesktopOverviewTab, visibility: DesktopOverviewVisibility): DesktopOverviewTab {
    if (!desktopOverviewTabHidden(tab, visibility)) return tab
    return DESKTOP_OVERVIEW_VIEWS[desktopOverviewViewOf(tab)][0]
}

export const DESKTOP_OVERVIEW_MANAGE_REASON = 'Only an admin or a manager of this Box can change this'
export const DESKTOP_OVERVIEW_PUBLISHED_UNAVAILABLE = 'Published is not available on this Mac. Nothing was opened.'

export const DESKTOP_OVERVIEW_IN_PLACE_TABS = ['services', 'mcp', 'skills', 'scheduled', 'triggers', 'monitoring', 'logs', 'data', 'files', 'memories', 'setup'] as const
export type DesktopOverviewInPlaceTab = (typeof DESKTOP_OVERVIEW_IN_PLACE_TABS)[number]

export const DESKTOP_OVERVIEW_ACCEPTED_PANEL_TABS = ['settings', 'tools'] as const
export type DesktopOverviewAcceptedPanelTab = (typeof DESKTOP_OVERVIEW_ACCEPTED_PANEL_TABS)[number]

export function desktopOverviewServicesDot(servicesNeedConfig: boolean | null) {
    return servicesNeedConfig === true
}

export function isDesktopOverviewAcceptedPanel(tab: DesktopOverviewTab): tab is DesktopOverviewAcceptedPanelTab {
    return (DESKTOP_OVERVIEW_ACCEPTED_PANEL_TABS as readonly string[]).includes(tab)
}

export function desktopOverviewAcceptedPanelMessage(tab: DesktopOverviewAcceptedPanelTab) {
    return `${desktopOverviewTabLabel(tab)} stays in its accepted panel. This overview does not open a second copy.`
}
