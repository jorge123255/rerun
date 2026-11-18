import 'server-only'
import { FOREMAN_AGENT_ID } from '@rerun/contracts'
import { getAgent } from '@/lib/engine/client'
import { DesktopHttpError } from '../auth'
import { readDesktopRuntime, type DesktopRuntime } from '../runtime'
import { engineOf } from '../settings'
import { assertDesktopWorkspaceAdmission } from '../workspace-admission'

export async function assertCurrentChiefSkillWorkspace(runtime: DesktopRuntime) {
    assertDesktopWorkspaceAdmission(runtime)
    const current = await readDesktopRuntime()
    if (current.workspaceId !== runtime.workspaceId || current.dataRoot !== runtime.dataRoot || current.launchNonce !== runtime.launchNonce)
        throw new DesktopHttpError(409, 'This workspace changed. Reopen Chief of Staff.')
    assertDesktopWorkspaceAdmission(runtime)
}

export async function assertManagedSkillChief(runtime: DesktopRuntime, signal: AbortSignal) {
    assertDesktopWorkspaceAdmission(runtime)
    const agent = await getAgent(engineOf(runtime), FOREMAN_AGENT_ID, { signal })
    if (agent.id !== FOREMAN_AGENT_ID || agent.config.kind !== 'foreman' || !agent.config.enabled || agent.config.ephemeral)
        throw new DesktopHttpError(409, 'Chief of Staff is unavailable.')
    signal.throwIfAborted()
    await assertCurrentChiefSkillWorkspace(runtime)
}
