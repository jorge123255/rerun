import 'server-only'
import type { Client } from '@libsql/client'
import { z } from 'zod'
import { desktopMcpSignInSourceSchema } from '../../../../../../packages/contracts/src/desktop-mcp-sign-in'
import { DesktopHttpError } from '../auth'
import { approvedSignInMethodSchema } from '../mcp-method-admission/contract'
import { hasExactMcpSignInOwner, type McpSignInOwner } from '../mcp-method-admission/owner'
import { credentialGenerationToken } from '../mcp/credential-generation'
import type { RemoteMcpStore } from '../mcp/store'
import { createDesktopSecretCrypto } from '../secret-requests/crypto'
import type { DesktopMcpSignInOAuthTarget } from './runtime'
import type { DesktopMcpSignInBrowserCapture } from './store'

export const desktopMcpBrowserApprovalSchema = `CREATE TABLE IF NOT EXISTS desktop_mcp_sign_in_browser_approvals (
    attempt_id TEXT PRIMARY KEY REFERENCES desktop_mcp_sign_in_attempts(attempt_id) ON DELETE CASCADE,
    sealed TEXT NOT NULL
)`

const browserApprovalSchema = z.object({
    source: desktopMcpSignInSourceSchema,
    approval: approvedSignInMethodSchema,
}).strict()

type Query = Pick<Client, 'execute'>
type BrowserCredential = NonNullable<Awaited<ReturnType<RemoteMcpStore['browserCredentialState']>>>
const approvalLifetimeMs = 5 * 60_000

export function createDesktopMcpBrowserApprovals(db: Client, store: Pick<RemoteMcpStore, 'credentialState'>, key: () => Buffer, scope: McpSignInOwner, now = Date.now) {
    const crypto = createDesktopSecretCrypto(key)
    const unavailable = () => new DesktopHttpError(409, 'Browser sign-in approval changed. Start a new sign-in attempt.')
    const context = (requestId: string, attemptId: string) => ({
        domain: 'staging' as const, key: JSON.stringify(['mcp-browser-approval-v1', scope.workspaceId, scope.sessionId]),
        agentId: scope.owner, requestId, attemptId, version: 1,
    })
    const generation = (name: string, credential: BrowserCredential) =>
        credentialGenerationToken(key(), scope.owner, name, credential, credential.sealed)

    const capture: DesktopMcpSignInBrowserCapture = async (query, { requestId, attemptId, source }) => {
        if (source.agentId !== scope.owner || source.sessionId !== scope.sessionId || !await hasExactMcpSignInOwner(query, scope)) throw unavailable()
        const { name, url, revision } = source.server
        const current = await store.credentialState(scope.owner, name, query)
        if (!current || current.revision !== revision || current.resource !== url) throw unavailable()
        const value = browserApprovalSchema.parse({ source, approval: {
            workspaceId: scope.workspaceId, owner: scope.owner, engineAgentId: scope.engineAgentId, engineSessionId: scope.engineSessionId,
            requestId, approvalId: attemptId, name, resource: url, revision, registrationId: current.registrationId,
            method: 'browser', credentialGeneration: generation(name, current), expiresAt: now() + approvalLifetimeMs,
        } })
        const bytes = Buffer.from(JSON.stringify(value))
        try {
            const sealed = await crypto.seal(context(requestId, attemptId), bytes)
            await query.execute({ sql: 'INSERT INTO desktop_mcp_sign_in_browser_approvals(attempt_id,sealed) VALUES(?,?)', args: [attemptId, sealed] })
        } finally { bytes.fill(0) }
    }

    async function read({ requestId, attemptId, source }: DesktopMcpSignInOAuthTarget, query: Query = db) {
        if (!attemptId || source.agentId !== scope.owner || source.sessionId !== scope.sessionId || !await hasExactMcpSignInOwner(query, scope)) return null
        const row = (await query.execute({ sql: `SELECT b.sealed FROM desktop_mcp_sign_in_browser_approvals b
            JOIN desktop_mcp_sign_in_attempts a ON a.attempt_id=b.attempt_id
            JOIN desktop_mcp_sign_in_requests r ON r.request_id=a.request_id
            WHERE r.request_id=? AND a.attempt_id=? AND r.active_attempt_id=a.attempt_id
                AND a.state='pending' AND r.status='connecting' AND r.agent_id=? AND r.session_id=?
                AND r.run_id=? AND r.source_message_id=? AND r.tool_call_id=? AND r.fingerprint=?`,
        args: [requestId, attemptId, scope.owner, scope.sessionId, source.runId, source.sourceMessageId, source.toolCallId, source.fingerprint] })).rows[0]
        if (typeof row?.sealed !== 'string' || row.sealed.length > 131_072) return null
        let bytes: Uint8Array | undefined
        try {
            bytes = await crypto.open(context(requestId, attemptId), row.sealed)
            const { source: savedSource, approval } = browserApprovalSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
            if (JSON.stringify(savedSource) !== JSON.stringify(desktopMcpSignInSourceSchema.parse(source))
                || approval.workspaceId !== scope.workspaceId || approval.owner !== scope.owner
                || approval.engineAgentId !== scope.engineAgentId || approval.engineSessionId !== scope.engineSessionId
                || approval.requestId !== requestId || approval.approvalId !== attemptId || approval.method !== 'browser'
                || approval.name !== source.server.name || approval.revision !== source.server.revision
                || approval.resource !== source.server.url || approval.expiresAt <= now()) return null
            return { approval, sealed: row.sealed }
        } catch { return null }
        finally { bytes?.fill(0) }
    }

    return {
        capture, read,
        async assertCurrent(target: DesktopMcpSignInOAuthTarget, credential: BrowserCredential) {
            const saved = await read(target)
            if (!saved || saved.approval.registrationId !== credential.registrationId
                || saved.approval.revision !== credential.revision || saved.approval.resource !== credential.resource
                || saved.approval.credentialGeneration !== generation(saved.approval.name, credential)) throw unavailable()
            return { requestId: saved.approval.requestId, attemptId: saved.approval.approvalId, expiresAt: saved.approval.expiresAt, sealedApproval: saved.sealed }
        },
    }
}
