import { describe, expect, it } from 'vitest'
import { desktopTeamReadCatalogRow, DESKTOP_TEAM_READ_ACTIVITY, DESKTOP_TEAM_READ_ICONS, DESKTOP_TEAM_READ_LABELS, DESKTOP_TEAM_READ_PERMISSION, DESKTOP_TEAM_READ_TOOL_NAMES } from './labels'

describe('desktop team read labels', () => {
    it('keeps the hosted See other coworkers copy and stays default-off', () => {
        expect(desktopTeamReadCatalogRow()).toEqual({
            id: 'teamRead',
            label: 'See other coworkers',
            description: 'Read their routines and runs',
            help: DESKTOP_TEAM_READ_PERMISSION.help,
            tools: DESKTOP_TEAM_READ_TOOL_NAMES,
            available: true,
            defaultEnabled: false,
        })
        expect(DESKTOP_TEAM_READ_PERMISSION.help).toContain("cannot change anything")
        expect(DESKTOP_TEAM_READ_PERMISSION.help).toContain("connected apps")
        expect(DESKTOP_TEAM_READ_LABELS.team_get_run).toBe("Read a Coworker's Run")
        expect(DESKTOP_TEAM_READ_ACTIVITY.team_status).toBe('Checking the team')
        expect(DESKTOP_TEAM_READ_ACTIVITY).not.toHaveProperty('team_list_schedules')
        expect(DESKTOP_TEAM_READ_ICONS.team_list_triggers).toBe('WebhookIcon')
        expect(DESKTOP_TEAM_READ_TOOL_NAMES).not.toContain('get_team_status')
    })
})
