import 'server-only'

import type { Client } from '@libsql/client'
import type { DesktopToolInstallDecision, DesktopToolInstallInspect, DesktopToolInstallPorts, DesktopToolInstallRunIdentity, DesktopToolInstallSnapshot } from '@rerun/contracts'
import { createDesktopToolInstallService, type DesktopToolInstallService } from '../../../../../engine/src/desktop/tool-install/service'
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

    function owned(snapshot: DesktopToolInstallSnapshot | null, sessionId: string): DesktopToolInstallSnapshot | null {
        if (snapshot && snapshot.sessionId !== sessionId) throw new Error('This installation belongs to another conversation.')
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
            await targetOf(sessionId)
            return owned(await service.read(operationId), sessionId)
        },

        async history(sessionId: string): Promise<DesktopToolInstallSnapshot[]> {
            await targetOf(sessionId)
            return ports.outcomes.list(sessionId)
        },

        async decide(sessionId: string, input: DesktopToolInstallDecision, signal?: AbortSignal): Promise<DesktopToolInstallSnapshot> {
            const snapshot = await current(sessionId, input.operationId)
            return service.decide(base(snapshot), input, signal)
        },

        async inspect(sessionId: string, input: DesktopToolInstallInspect, signal?: AbortSignal): Promise<DesktopToolInstallSnapshot> {
            const snapshot = await current(sessionId, input.operationId)
            return service.inspect(base(snapshot), input, signal)
        },
    }
}
