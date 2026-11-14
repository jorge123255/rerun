import { desktopOverviewSiblingTabs, desktopOverviewViewOf, shownDesktopOverviewTab, type DesktopOverviewDestination, type DesktopOverviewTab, type DesktopOverviewVisibility } from './sections'

export type DesktopOverviewNavigation = {
    tab: DesktopOverviewTab | null
}

export const closedDesktopOverview: DesktopOverviewNavigation = { tab: null }

export function openDesktopOverviewDestination(tab: DesktopOverviewDestination, visibility: DesktopOverviewVisibility): DesktopOverviewNavigation {
    return { tab: shownDesktopOverviewTab(tab, visibility) }
}

export function selectDesktopOverviewTab(current: DesktopOverviewTab, next: DesktopOverviewTab, visibility: DesktopOverviewVisibility): DesktopOverviewNavigation {
    const shown = shownDesktopOverviewTab(next, visibility)
    if (desktopOverviewViewOf(shown) !== desktopOverviewViewOf(shownDesktopOverviewTab(current, visibility))) return { tab: current }
    if (!desktopOverviewSiblingTabs(current, visibility).includes(shown)) return { tab: shownDesktopOverviewTab(current, visibility) }
    return { tab: shown }
}

export type DesktopOverviewControl = DesktopOverviewDestination | 'computer' | 'delete'

export function desktopOverviewFocusGroups(computer: boolean): DesktopOverviewControl[][] {
    return [
        ['services', 'skills', 'memories', 'scheduled'],
        ['files', 'data'],
        ...(computer ? [['computer'] as DesktopOverviewControl[]] : []),
        ['monitoring', 'settings'],
        ['delete'],
    ]
}

export function moveDesktopOverviewFocus(current: DesktopOverviewControl, key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End', groups: readonly (readonly DesktopOverviewControl[])[]): DesktopOverviewControl {
    const groupIndex = groups.findIndex(group => group.includes(current))
    if (groupIndex < 0) return current
    const group = groups[groupIndex]
    const index = group.indexOf(current)
    if (key === 'Home') return group[0]
    if (key === 'End') return group[group.length - 1]
    if (key === 'ArrowLeft') return group[(index - 1 + group.length) % group.length]
    if (key === 'ArrowRight') return group[(index + 1) % group.length]
    const nextGroup = groups[key === 'ArrowUp' ? Math.max(0, groupIndex - 1) : Math.min(groups.length - 1, groupIndex + 1)]
    return nextGroup[Math.min(index, nextGroup.length - 1)]
}
