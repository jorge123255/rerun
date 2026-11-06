import 'server-only'

import type { DesktopClaudePlanAttemptAction, DesktopClaudePlanCompleteInput, DesktopClaudePlanOAuth, type DesktopClaudePlanAttemptStore, type DesktopClaudePlanCredentialCustody, type DesktopClaudePlanChatStore, type DesktopClaudePlanChatResult } from '@rerun/contracts'
import { createDesktopClaudePlanAuth } from '../../../../../engine/src/desktop/claude-plan/auth'
import { assertCoworkerNotDeleting } from '../coworker-delete'
import { openDesktopDatabase } from '../database'
import type { DesktopRuntime } from '../runtime'
import { findDesktopAgent } from '../store'

export function createDesktopClaudePlanServer(runtime: DesktopRuntime, ports: { oauth: DesktopClaudePlanOAuth; custody: DesktopClaudePlanCredentialCustody; outcomes: DesktopClaudePlanAttemptStore; chats: DesktopClaudePlanChatStore }) {
    const auth = createDesktopClaudePlanAuth(ports)

    async function ownerOf(agentId: string) {
        const db = await openDesktopDatabase(runtime.dataRoot)
        await assertCoworkerNotDeleting(db, agentId)
        const agent = await findDesktopAgent(db, agentId)
        if (!agent) throw new Error('Coworker not found')
        return agent
    }

    function owned(attempt: { agentId: string }, agentId: string): void {
        if (attempt.agentId !== agentId) throw new Error('This Claude sign-in belongs to another coworker.')
    }

    return {
        start: async (agentId: string) => {
            await ownerOf(agentId)
            return auth.start(agentId)
        },
        status: async (agentId: string, attemptId: string) => {
            await ownerOf(agentId)
            const attempt = await auth.status(attemptId)
            if (attempt) owned(attempt, agentId)
            return attempt
        },
        complete: async (agentId: string, input: DesktopClaudePlanCompleteInput, signal?: AbortSignal) => {
            await ownerOf(agentId)
            const attempt = await ports.outcomes.read(input.attemptId)
            if (attempt) owned(attempt, agentId)
            return auth.complete(input, signal)
        },
        cancel: async (agentId: string, input: DesktopClaudePlanAttemptAction) => {
            await ownerOf(agentId)
            const attempt = await ports.outcomes.read(input.attemptId)
            if (attempt) owned(attempt, agentId)
            return auth.cancel(input)
        },
        disconnect: async (agentId: string, input: DesktopClaudePlanAttemptAction) => {
            await ownerOf(agentId)
            const attempt = await ports.outcomes.read(input.attemptId)
            if (attempt) owned(attempt, agentId)
            return auth.disconnect(input)
        },
        async chat(agentId: string, operationId: string): Promise<DesktopClaudePlanChatResult | null> {
            await ownerOf(agentId)
            const result = await ports.chats.read(operationId)
            if (result && result.agentId !== agentId) throw new Error('This Claude chat belongs to another coworker.')
            return result
        },
    }
}
