// Skills is explicitly granted per coworker. Human editing and accepting one proposal never
// enable this boolean or change the original tools.skills master switch.

type SkillGrantConfig = {
    enabled?: boolean
    tools?: { skills?: boolean; desktopToolGrants?: object }
    selfImprovement?: { enabled?: boolean }
}

function skillsGrant(config: SkillGrantConfig): boolean {
    const grants = config.tools?.desktopToolGrants as Record<string, boolean> | undefined
    return grants?.skills === true
}

export function desktopSkillToolsAllowed(config: SkillGrantConfig | null | undefined): boolean {
    if (!config?.enabled) return false
    if (config.tools?.skills === false) return false
    return skillsGrant(config)
}

export function desktopSkillProposeAllowed(config: SkillGrantConfig | null | undefined): boolean {
    return desktopSkillToolsAllowed(config) && config?.selfImprovement?.enabled === true
}
