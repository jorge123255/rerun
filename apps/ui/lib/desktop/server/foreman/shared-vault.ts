import 'server-only'
import { FOREMAN_AGENT_ID } from '@rerun/contracts'
import type { Client } from '@libsql/client'
import { z } from 'zod'
import type { McpRunIdentity } from '../mcp/bridge'
import { type DesktopRuntime, readDesktopRuntime } from '../runtime'
import { assertDesktopWorkspaceAdmission } from '../workspace-admission'
import { foremanTurn, ownedForemanChat, ownedForemanDispatch } from './chat-store'

const managed = z.object({ id: z.literal(FOREMAN_AGENT_ID), config: z.object({
    kind: z.literal('foreman'), enabled: z.literal(true), ephemeral: z.boolean().optional(),
}) })
const activeRun = z.object({ id: z.string(), agentId: z.literal(FOREMAN_AGENT_ID), sessionId: z.string(), status: z.literal('running') })

export async function authorizeForemanSharedVault(runtime: DesktopRuntime, db: Client, identity: McpRunIdentity,
    signal: AbortSignal, releasing: boolean, engineJson: (path: string, signal: AbortSignal) => Promise<unknown>) {
    signal.throwIfAborted()
    if (identity.engineAgentId !== FOREMAN_AGENT_ID) throw new Error('Chief identity changed')
    if (releasing) {
        // Closing a catalog remains possible after Stop, but only for its original chat.
        const turn = await foremanTurn(db, identity.runId)
        if (!turn || turn.body.binding.workspaceId !== String(runtime.workspaceId) || turn.body.binding.runId !== identity.runId ||
            turn.body.sessionId !== identity.sessionId || (await ownedForemanChat(db, turn.body.binding)).sessionId !== identity.sessionId)
            throw new Error('Chief conversation changed')
        return FOREMAN_AGENT_ID
    }
    const owner = await ownedForemanDispatch(runtime, db, identity.sessionId, identity.runId)
    const [agent, run] = await Promise.all([
        engineJson('/agents/foreman', signal).then(value => managed.parse(value)),
        engineJson('/agents/foreman/runs/' + encodeURIComponent(identity.runId), signal).then(value => activeRun.parse(value)),
    ])
    if (agent.config.ephemeral || run.id !== identity.runId || run.sessionId !== owner.sessionId) throw new Error('Chief run changed')
    const current = await readDesktopRuntime()
    if (current.workspaceId !== runtime.workspaceId || current.launchNonce !== runtime.launchNonce || current.dataRoot !== runtime.dataRoot ||
        (await ownedForemanDispatch(runtime, db, identity.sessionId, identity.runId)).chat.chatId !== owner.chat.chatId)
        throw new Error('Chief workspace changed')
    signal.throwIfAborted()
    assertDesktopWorkspaceAdmission(runtime)
    return FOREMAN_AGENT_ID
}
