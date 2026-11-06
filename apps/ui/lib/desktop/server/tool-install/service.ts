import 'server-only'

import type { Client } from '@libsql/client'
import type { DesktopToolInstallDecision, DesktopToolInstallInspect, DesktopToolInstallPorts, DesktopToolInstallRunIdentity, DesktopToolInstallSnapshot } from '@rerun/contracts'
import { createDesktopToolInstallService, type DesktopToolInstallService } from '@rerun/contracts'
import { assertCoworkerNotDeleting } from '../coworker-delete'
import { openDesktopDatabase } from '../database'
import type { DesktopRuntime } from '../runtime'
import { findDesktopAgent, findDesktopSession, type DesktopAgent, type DesktopSession } from '../store'

type Target = { db: Client; agent: DesktopAgent; session: DesktopSession }
type BaseIdentity = Omit<DesktopToolInstallRunIdentity, 'guest'>

export function createDesktopToolInstallServer(runtime: DesktopRuntime, ports: DesktopToolInstallPorts) {
    const service: DesktopToolInstallService = createDesktopToolInstallService(ports)

    async function targetOf(sessionId: string): Promise<Target> {
        const db = await openDesktopDatabase(runtime.dataRoot)
        const session = await findDesktopSession(db, sessionId)
        if (!session) throw new Error('Conversation not found')
        await assertCoworkerNotDeleting(db, session.agentId)
        const agent = await findDesktopAgent(db, session.agentId)
        if (!agent) throw new Error('Coworker not found')
        return { db, agent, session }
    }

    function owned(snapshot: DesktopToolInstallSnapshot | null, sessionId: string, agentId?: string): DesktopToolInstallSnapshot | null {
        if (snapshot && (snapshot.sessionId !== sessionId || agentId !== undefined && snapshot.agentId !== agentId)) throw new Error('This installation belongs to another conversation.')
        return snapshot
    }

    function base(snapshot: DesktopToolInstallSnapshot): BaseIdentity {
        return {
            agentId: snapshot.agentId,
            sessionId: snapshot.sessionId,
            runId: snapshot.runId,
            toolCallId: snapshot.toolCallId,
            proposalRevision: snapshot.proposalRevision,
        }
    }

    async function current(sessionId: string, operationId: string): Promise<DesktopToolInstallSnapshot> {
        const snapshot = owned(await service.read(operationId), sessionId)
        if (!snapshot) throw new Error('Installation not found')
        return snapshot
    }

    return {
        async read(sessionId: string, operationId: string): Promise<DesktopToolInstallSnapshot | null> {
            const target = await targetOf(sessionId)
            const result = owned(await service.read(operationId), sessionId, target.agent.id)
            const current = await targetOf(sessionId)
            if (current.agent.engineAgentId !== target.agent.engineAgentId || current.session.engineSessionId !== target.session.engineSessionId) throw new Error('Installation conversation changed')
            return result
        },

        async history(sessionId: string): Promise<DesktopToolInstallSnapshot[]> {
            const target = await targetOf(sessionId)
            const rows = await ports.outcomes.list(sessionId)
            for (const row of rows) owned(row, sessionId, target.agent.id)
            const current = await targetOf(sessionId)
            if (current.agent.engineAgentId !== target.agent.engineAgentId || current.session.engineSessionId !== target.session.engineSessionId) throw new Error('Installation conversation changed')
            return rows
        },

        async decide(sessionId: string, input: DesktopToolInstallDecision, signal?: AbortSignal): Promise<DesktopToolInstallSnapshot> {
            await targetOf(sessionId)
            const snapshot = await current(sessionId, input.operationId)
            return service.decide(base(snapshot), input, signal)
        },

        async inspect(sessionId: string, input: DesktopToolInstallInspect, signal?: AbortSignal): Promise<DesktopToolInstallSnapshot> {
            await targetOf(sessionId)
            const snapshot = await current(sessionId, input.operationId)
            return service.inspect(base(snapshot), input, signal)
        },
    }
}
