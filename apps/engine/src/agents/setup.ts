import { readFile } from 'node:fs/promises'
import { configPath } from '../config/paths.js'
import { withAgentLock } from './lock.js'
import { writeAgentConfig } from './config-write.js'
import { getAgent, reloadAgent } from './registry.js'
import { agentConfigSchema, type LoadedAgent } from './types.js'
import { nowIso } from '../lib/ids.js'
import { getSession } from '../db/repos/sessions.js'
import type { SessionRow } from '../db/schema.js'
import type { RunTrigger } from '../runtime/context.js'

// Guided setup is pending when its author said it was needed, the instructions travelled with the
// folder, and nobody has run them here yet. The same verdict gates the tool, the system prompt
// section and the composer in the UI, so it is stated once.
export function hasPendingSetup(agent: LoadedAgent): boolean {
    return agent.config.setup.required === true && agent.config.setup.completedAt === null && agent.install.trim().length > 0
}

// On the Mac the UI keeps an explicit skip separately from completion so setup can be resumed.
// Withhold both the setup prompt and install_complete from every turn outside that live scope.
export function desktopSetupAgentForTurn(agent: LoadedAgent, sessionId: string, trigger: RunTrigger): LoadedAgent {
    if (!agent.install || (trigger.source === 'chat' && !trigger.calledBy && !trigger.desktopSetupSkipped
        && agent.config.setup.sessionId === sessionId)) return agent
    return { ...agent, install: '' }
}

export async function markSetupComplete(id: string): Promise<string> {
    return withAgentLock(id, async () => {
        const current = agentConfigSchema.parse(JSON.parse(await readFile(configPath(id), 'utf8')))
        const completedAt = nowIso()
        await writeAgentConfig(id, { ...current, setup: { ...current.setup, completedAt } })
        await reloadAgent(id)
        return completedAt
    })
}

export type InstallClaim = { session: SessionRow } | { inFlight: string }

// Starting the guided setup claims it for one conversation. Any later start, from another tab, the
// foreman or another device, is pointed back at that conversation instead of opening a second
// install beside it. The claim lapses with its session, and once the setup is no longer pending.
export async function claimInstallSession(id: string, create: () => Promise<SessionRow>): Promise<InstallClaim> {
    return withAgentLock(id, async () => {
        const agent = await getAgent(id)
        const claimed = agent.config.setup.sessionId
        if (hasPendingSetup(agent) && claimed && (await getSession(id, claimed))) return { inFlight: claimed }

        const session = await create()
        if (!hasPendingSetup(agent)) return { session }
        const current = agentConfigSchema.parse(JSON.parse(await readFile(configPath(id), 'utf8')))
        await writeAgentConfig(id, { ...current, setup: { ...current.setup, sessionId: session.id } })
        await reloadAgent(id)
        return { session }
    })
}
