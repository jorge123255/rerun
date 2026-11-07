import { z } from 'zod'

// FX09 evidence packet — inert option matrix for the duplicate grant/credential policy.
// Nothing here is wired: no barrel export, no runtime reads these values. Enforcement waits on
// an explicit user decision recorded in docs/desktop-next-duplicate-policy-fx09-handoff.md.
// See that document for the SOURCE vs SPEC citations behind each option.

export const desktopDuplicatePolicyOptions = [
    // Status quo: same-box Duplicate copies config.json verbatim, so desktopToolGrants,
    // desktopCodexGrants, desktopWorkspaceRead, tool enables, .env values, mcp/ OAuth bundles,
    // data/agent.db records, memory/, schedules and triggers all travel to the copy.
    'inherit-source',
    // Strip grant-bearing config fields on duplicate only (tools.*, desktopToolGrants,
    // desktopCodexGrants, desktopWorkspaceRead); keep .env, mcp/, data/agent.db, memory/,
    // schedules/ and triggers/ copying as today. Matches the recorded "no inherited grants"
    // requirement while leaving the separate credential-file decision open.
    'grants-off-credentials-inherited',
    // Duplicate applies the portable inspector's normalization: grants off, connections and
    // provider/model reset, mcpServers emptied, selfImprovement stripped; .env, mcp/, memory/,
    // data/, schedules/, triggers/ and history roots excluded from the copy.
    'portable-parity',
    // Grants off plus credential files (.env values, mcp/ bundles) excluded, but memory/,
    // data/agent.db, schedules/ and triggers/ still copied.
    'grants-off-credentials-excluded',
] as const

export const desktopDuplicatePolicyOptionSchema = z.enum(desktopDuplicatePolicyOptions)
export type DesktopDuplicatePolicyOption = z.infer<typeof desktopDuplicatePolicyOptionSchema>

export type DesktopDuplicatePolicyAspect = 'grants' | 'toolEnables' | 'envValues' | 'mcpOAuth' | 'connectionModel' | 'mcpServers' | 'privateDatabase' | 'memory' | 'schedulesTriggers' | 'chats' | 'enabled'

export type DesktopDuplicatePolicyMatrixRow = {
    option: DesktopDuplicatePolicyOption
    aspect: DesktopDuplicatePolicyAspect
    // 'inherit' = copy travels verbatim, 'reset' = copy starts without it, 'rotate' = copy gets a
    // fresh equivalent (new trigger token, rebaselined schedule), 'excluded' = never copied.
    outcome: 'inherit' | 'reset' | 'rotate' | 'excluded'
    // Whether the outcome needs a new code path or falls out of an existing seam.
    seam: 'existing' | 'new'
}

export const DESKTOP_DUPLICATE_POLICY_ASPECTS: readonly DesktopDuplicatePolicyAspect[] = [
    'grants', 'toolEnables', 'envValues', 'mcpOAuth', 'connectionModel', 'mcpServers',
    'privateDatabase', 'memory', 'schedulesTriggers', 'chats', 'enabled',
]

// Documentation matrix only — enforced by review, not code. Rows describe observed SOURCE
// behavior at base 8297fe64 plus the portable inspector's reset rules; nothing here asserts a
// chosen policy.
export const desktopDuplicatePolicyMatrix: readonly DesktopDuplicatePolicyMatrixRow[] = [
    { option: 'inherit-source', aspect: 'grants', outcome: 'inherit', seam: 'existing' },
    { option: 'inherit-source', aspect: 'toolEnables', outcome: 'inherit', seam: 'existing' },
    { option: 'inherit-source', aspect: 'envValues', outcome: 'inherit', seam: 'existing' },
    { option: 'inherit-source', aspect: 'mcpOAuth', outcome: 'inherit', seam: 'existing' },
    { option: 'inherit-source', aspect: 'connectionModel', outcome: 'inherit', seam: 'existing' },
    { option: 'inherit-source', aspect: 'mcpServers', outcome: 'inherit', seam: 'existing' },
    { option: 'inherit-source', aspect: 'privateDatabase', outcome: 'inherit', seam: 'existing' },
    { option: 'inherit-source', aspect: 'memory', outcome: 'inherit', seam: 'existing' },
    { option: 'inherit-source', aspect: 'schedulesTriggers', outcome: 'rotate', seam: 'existing' },
    { option: 'inherit-source', aspect: 'chats', outcome: 'excluded', seam: 'existing' },
    { option: 'inherit-source', aspect: 'enabled', outcome: 'inherit', seam: 'existing' },

    { option: 'grants-off-credentials-inherited', aspect: 'grants', outcome: 'reset', seam: 'new' },
    { option: 'grants-off-credentials-inherited', aspect: 'toolEnables', outcome: 'reset', seam: 'new' },
    { option: 'grants-off-credentials-inherited', aspect: 'envValues', outcome: 'inherit', seam: 'existing' },
    { option: 'grants-off-credentials-inherited', aspect: 'mcpOAuth', outcome: 'inherit', seam: 'existing' },
    { option: 'grants-off-credentials-inherited', aspect: 'connectionModel', outcome: 'inherit', seam: 'existing' },
    { option: 'grants-off-credentials-inherited', aspect: 'mcpServers', outcome: 'inherit', seam: 'existing' },
    { option: 'grants-off-credentials-inherited', aspect: 'privateDatabase', outcome: 'inherit', seam: 'existing' },
    { option: 'grants-off-credentials-inherited', aspect: 'memory', outcome: 'inherit', seam: 'existing' },
    { option: 'grants-off-credentials-inherited', aspect: 'schedulesTriggers', outcome: 'rotate', seam: 'existing' },
    { option: 'grants-off-credentials-inherited', aspect: 'chats', outcome: 'excluded', seam: 'existing' },
    { option: 'grants-off-credentials-inherited', aspect: 'enabled', outcome: 'inherit', seam: 'existing' },

    { option: 'portable-parity', aspect: 'grants', outcome: 'reset', seam: 'new' },
    { option: 'portable-parity', aspect: 'toolEnables', outcome: 'reset', seam: 'new' },
    { option: 'portable-parity', aspect: 'envValues', outcome: 'excluded', seam: 'new' },
    { option: 'portable-parity', aspect: 'mcpOAuth', outcome: 'excluded', seam: 'new' },
    { option: 'portable-parity', aspect: 'connectionModel', outcome: 'reset', seam: 'new' },
    { option: 'portable-parity', aspect: 'mcpServers', outcome: 'reset', seam: 'new' },
    { option: 'portable-parity', aspect: 'privateDatabase', outcome: 'excluded', seam: 'new' },
    { option: 'portable-parity', aspect: 'memory', outcome: 'excluded', seam: 'new' },
    { option: 'portable-parity', aspect: 'schedulesTriggers', outcome: 'excluded', seam: 'new' },
    { option: 'portable-parity', aspect: 'chats', outcome: 'excluded', seam: 'existing' },
    { option: 'portable-parity', aspect: 'enabled', outcome: 'inherit', seam: 'new' },

    { option: 'grants-off-credentials-excluded', aspect: 'grants', outcome: 'reset', seam: 'new' },
    { option: 'grants-off-credentials-excluded', aspect: 'toolEnables', outcome: 'reset', seam: 'new' },
    { option: 'grants-off-credentials-excluded', aspect: 'envValues', outcome: 'excluded', seam: 'new' },
    { option: 'grants-off-credentials-excluded', aspect: 'mcpOAuth', outcome: 'excluded', seam: 'new' },
    { option: 'grants-off-credentials-excluded', aspect: 'connectionModel', outcome: 'inherit', seam: 'existing' },
    { option: 'grants-off-credentials-excluded', aspect: 'mcpServers', outcome: 'inherit', seam: 'existing' },
    { option: 'grants-off-credentials-excluded', aspect: 'privateDatabase', outcome: 'inherit', seam: 'existing' },
    { option: 'grants-off-credentials-excluded', aspect: 'memory', outcome: 'inherit', seam: 'existing' },
    { option: 'grants-off-credentials-excluded', aspect: 'schedulesTriggers', outcome: 'rotate', seam: 'existing' },
    { option: 'grants-off-credentials-excluded', aspect: 'chats', outcome: 'excluded', seam: 'existing' },
    { option: 'grants-off-credentials-excluded', aspect: 'enabled', outcome: 'inherit', seam: 'existing' },
]
