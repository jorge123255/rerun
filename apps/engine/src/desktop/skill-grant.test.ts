import { describe, expect, it } from 'vitest'
import { desktopSkillProposeAllowed, desktopSkillToolsAllowed } from './skill-grant.js'

const enabled = { enabled: true, selfImprovement: { enabled: true }, tools: { skills: true, desktopToolGrants: { skills: true } } }

describe('desktopSkillToolsAllowed', () => {
    it('stays off when the skills grant is missing', () => {
        expect(desktopSkillToolsAllowed({ enabled: true, tools: { skills: true } })).toBe(false)
        expect(desktopSkillToolsAllowed({ enabled: true, tools: { skills: true, desktopToolGrants: {} } })).toBe(false)
    })

    it('stays off when the grant is set and tools.skills is off', () => {
        expect(desktopSkillToolsAllowed({ enabled: true, tools: { skills: false, desktopToolGrants: { skills: true } } })).toBe(false)
    })

    it('stays off when the coworker is disabled', () => {
        expect(desktopSkillToolsAllowed({ ...enabled, enabled: false })).toBe(false)
        expect(desktopSkillToolsAllowed(null)).toBe(false)
    })

    it('allows the tools only when the coworker, the skills switch, and the grant are all on', () => {
        expect(desktopSkillToolsAllowed(enabled)).toBe(true)
    })

    it('allows skill_propose only when self-improvement is also on', () => {
        expect(desktopSkillProposeAllowed(enabled)).toBe(true)
        expect(desktopSkillProposeAllowed({ ...enabled, selfImprovement: { enabled: false } })).toBe(false)
    })
})
