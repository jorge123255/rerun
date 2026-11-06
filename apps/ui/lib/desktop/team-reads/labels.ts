import {
    DESKTOP_TEAM_READ_ACTIVITY,
    DESKTOP_TEAM_READ_GRANT_ID,
    DESKTOP_TEAM_READ_ICONS,
    DESKTOP_TEAM_READ_LABELS,
    DESKTOP_TEAM_READ_PERMISSION,
    DESKTOP_TEAM_READ_PROMPT,
    DESKTOP_TEAM_READ_TOOL_NAMES,
} from '../../../../../packages/contracts/src/desktop-team-reads.ts'

/** Catalog row root inserts into `desktopRerunToolCatalog`. `available` means the switch can be shown. The grant stays off until `desktopToolGrants.teamRead` is exactly true. */
export function desktopTeamReadCatalogRow() {
    return {
        id: DESKTOP_TEAM_READ_GRANT_ID,
        label: DESKTOP_TEAM_READ_PERMISSION.label,
        description: DESKTOP_TEAM_READ_PERMISSION.blurb,
        help: DESKTOP_TEAM_READ_PERMISSION.help,
        tools: DESKTOP_TEAM_READ_TOOL_NAMES,
        available: true as const,
        defaultEnabled: false as const,
    }
}

export {
    DESKTOP_TEAM_READ_ACTIVITY,
    DESKTOP_TEAM_READ_GRANT_ID,
    DESKTOP_TEAM_READ_ICONS,
    DESKTOP_TEAM_READ_LABELS,
    DESKTOP_TEAM_READ_PERMISSION,
    DESKTOP_TEAM_READ_PROMPT,
    DESKTOP_TEAM_READ_TOOL_NAMES,
}
