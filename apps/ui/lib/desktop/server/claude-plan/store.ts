import 'server-only'

import type { Client } from '@libsql/client'
import { desktopClaudePlanAttemptSchema, desktopClaudePlanChatResultSchema, type DesktopClaudePlanAttempt, type DesktopClaudePlanChatIdentity, type DesktopClaudePlanChatResult } from '@rerun/contracts'
import { desktopClaudePlanSchema } from './schema'

export function desktopClaudePlanStore(db: Client) {
    async function initialize() {
        await db.executeMultiple(desktopClaudePlanSchema)
    }

    return {
        attempts: {
            async begin(attempt: DesktopClaudePlanAttempt): Promise<'execute' | DesktopClaudePlanAttempt> {
                await initialize()
                const row = (await db.execute({ sql: 'SELECT attempt FROM desktop_claude_plan_attempts WHERE attempt_id = ?', args: [attempt.attemptId] })).rows[0]
                if (row) {
                    const current = desktopClaudePlanAttemptSchema.parse(JSON.parse(String(row.attempt)))
                    if (current.agentId !== attempt.agentId || current.verifier !== attempt.verifier || current.state !== attempt.state || current.authorizeUrl !== attempt.authorizeUrl) throw new Error('Claude sign-in identity conflict')
                    return current
                }
                await db.execute({ sql: 'INSERT INTO desktop_claude_plan_attempts(attempt_id,attempt,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(attempt_id) DO NOTHING', args: [attempt.attemptId, JSON.stringify(attempt), attempt.createdAt, attempt.updatedAt] })
                return 'execute'
            },

            async complete(attempt: DesktopClaudePlanAttempt): Promise<void> {
                await initialize()
                const row = (await db.execute({ sql: 'SELECT attempt FROM desktop_claude_plan_attempts WHERE attempt_id = ?', args: [attempt.attemptId] })).rows[0]
                if (!row) throw new Error('Claude sign-in reservation is missing')
                const current = desktopClaudePlanAttemptSchema.parse(JSON.parse(String(row.attempt)))
                if (current.agentId !== attempt.agentId || Number(current.revision) >= Number(attempt.revision)) throw new Error('Claude sign-in completion conflict')
                await db.execute({ sql: 'UPDATE desktop_claude_plan_attempts SET attempt=?,updated_at=? WHERE attempt_id=?', args: [JSON.stringify(attempt), attempt.updatedAt, attempt.attemptId] })
            },

            async read(attemptId: string): Promise<DesktopClaudePlanAttempt | null> {
                await initialize()
                const row = (await db.execute({ sql: 'SELECT attempt FROM desktop_claude_plan_attempts WHERE attempt_id = ?', args: [attemptId] })).rows[0]
                return row ? desktopClaudePlanAttemptSchema.parse(JSON.parse(String(row.attempt))) : null
            },

            async active(agentId: string): Promise<DesktopClaudePlanAttempt | null> {
                await initialize()
                const rows = (await db.execute({ sql: 'SELECT attempt FROM desktop_claude_plan_attempts WHERE agentId = ? ORDER BY created_at DESC LIMIT 20', args: [agentId] })).rows
                const attempts = rows.map(row => desktopClaudePlanAttemptSchema.parse(JSON.parse(String(row.attempt))))
                return attempts.find(attempt => ['waiting', 'checking'].includes(attempt.phase)) ?? attempts[0] ?? null
            },

            async connected(agentId: string): Promise<DesktopClaudePlanAttempt | null> {
                await initialize()
                const row = (await db.execute({ sql: 'SELECT attempt FROM desktop_claude_plan_attempts WHERE agentId = ? ORDER BY created_at DESC LIMIT 1', args: [agentId] })).rows[0]
                if (!row) return null
                const attempt = desktopClaudePlanAttemptSchema.parse(JSON.parse(String(row.attempt)))
                return attempt.phase === 'connected' ? attempt : null
            },
        },

        chats: {
            async begin(identity: DesktopClaudePlanChatIdentity, operationId: string): Promise<'execute' | DesktopClaudePlanChatResult> {
                await initialize()
                const row = (await db.execute({ sql: 'SELECT result FROM desktop_claude_plan_chats WHERE operation_id = ?', args: [operationId] })).rows[0]
                if (row) {
                    if (String(row.result) === 'null') return 'execute'
                    const current = desktopClaudePlanChatResultSchema.parse(JSON.parse(String(row.result)))
                    if (current.operationId !== operationId || current.agentId !== identity.agentId || current.sessionId !== identity.sessionId || current.runId !== identity.runId || current.toolCallId !== identity.toolCallId || current.credentialRevision !== identity.credentialRevision) throw new Error('Claude chat identity conflict')
                    return current
                }
                const now = new Date().toISOString()
                await db.execute({ sql: 'INSERT INTO desktop_claude_plan_chats(operation_id,result,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(operation_id) DO NOTHING', args: [operationId, 'null', now, now] })
                return 'execute'
            },

            async complete(result: DesktopClaudePlanChatResult): Promise<void> {
                await initialize()
                const row = (await db.execute({ sql: 'SELECT result FROM desktop_claude_plan_chats WHERE operation_id = ?', args: [result.operationId] })).rows[0]
                if (!row) throw new Error('Claude chat reservation is missing')
                if (String(row.result) !== 'null') {
                    const current = desktopClaudePlanChatResultSchema.parse(JSON.parse(String(row.result)))
                    if (JSON.stringify(current) !== JSON.stringify(result)) throw new Error('Claude chat completion conflict')
                    return
                }
                await db.execute({ sql: 'UPDATE desktop_claude_plan_chats SET result=?,updated_at=? WHERE operation_id=?', args: [JSON.stringify(result), result.updatedAt, result.operationId] })
            },

            async read(operationId: string): Promise<DesktopClaudePlanChatResult | null> {
                await initialize()
                const row = (await db.execute({ sql: 'SELECT result FROM desktop_claude_plan_chats WHERE operation_id = ?', args: [operationId] })).rows[0]
                return row && String(row.result) !== 'null' ? desktopClaudePlanChatResultSchema.parse(JSON.parse(String(row.result))) : null
            },
        },
    }
}
