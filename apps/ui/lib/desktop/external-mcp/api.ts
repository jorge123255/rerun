import 'server-only'
import { z } from 'zod'
import {
    EXTERNAL_MCP_COPY,
    externalMcpCreateInputSchema,
    externalMcpCreateResultSchema,
    externalMcpEnableInputSchema,
    externalMcpListResponseSchema,
    externalMcpListenerResultSchema,
    externalMcpListenerViewSchema,
    externalMcpRevokeInputSchema,
    externalMcpRevokeResultSchema,
    externalMcpWorkspaceIdSchema,
    type ExternalMcpRefusal,
} from '@rerun/contracts'
import { authenticateDesktopRequest, DesktopHttpError } from '../server/auth'
import { openDesktopDatabase } from '../server/database'
import { readDesktopJson } from '../server/request-json'
import type { DesktopRuntime } from '../server/runtime'
import {
    createDesktopExternalMcpKey,
    disableDesktopExternalMcpListener,
    enableDesktopExternalMcpListener,
    listDesktopExternalMcpKeys,
    readDesktopExternalMcpListener,
    revokeDesktopExternalMcpKey,
} from '../server/external-mcp-authority/client'
import { desktopExternalMcpAttemptSchema, type DesktopExternalMcpAttempt } from './attempts'
import { buildImportPrompt } from '@/lib/agent-import/prompt'
import { importSource } from '@/lib/agent-import/sources'
import { IMPORT_KEY_TTL_MS } from '@/lib/mcp/import-scope'
import { DESKTOP_IMPORT_KEY_SCOPES, listDesktopImportKeyIds, markDesktopImportKey } from '../server/external-mcp-tools/import-keys'
import { desktopImportKeyRequestSchema, type DesktopImportKeyResult } from './import'
import { externalMcpEndpoint } from './snippets'
import { desktopExternalMcpAttemptStore } from './attempt-store'

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
const workspace = (runtime: DesktopRuntime, raw: unknown) => {
    const workspaceId = externalMcpWorkspaceIdSchema.parse(raw)
    if (runtime.workspaceId !== workspaceId) throw new DesktopHttpError(409, EXTERNAL_MCP_COPY.workspace)
    return workspaceId
}
const requestedWorkspace = (request: Request) => {
    const value = new URL(request.url).searchParams.get('workspaceId')
    return value && /^[1-9]\d*$/.test(value) ? Number(value) : Number.NaN
}

function failure(error: unknown): Response {
    const status = error instanceof DesktopHttpError ? error.status : error instanceof z.ZodError ? 400 : 503
    const result: ExternalMcpRefusal = {
        ok: false,
        code: status === 400 ? 'invalid' : status === 401 ? 'unauthorized' : status === 403 ? 'forbidden_origin' : status === 405 ? 'unsupported' : status === 503 ? 'uncertain' : 'replay_conflict',
        message: error instanceof DesktopHttpError && status < 500 ? error.message : status === 400 ? 'This external-client request is invalid.' : EXTERNAL_MCP_COPY.uncertain,
    }
    return json(result, status)
}

async function keys(request: Request): Promise<Response> {
    try {
        const runtime = await authenticateDesktopRequest(request)
        if (request.method === 'GET') {
            const workspaceId = workspace(runtime, requestedWorkspace(request))
            const result = externalMcpListResponseSchema.parse(await listDesktopExternalMcpKeys(runtime, workspaceId))
            if ('ok' in result && !result.ok) return json(result, 409)
            if (!('ok' in result) && (result.workspaceId !== workspaceId || result.keys.some(key => key.workspaceId !== workspaceId))) throw new DesktopHttpError(409, EXTERNAL_MCP_COPY.workspace)
            return json(result)
        }
        if (request.method === 'POST') {
            const input = externalMcpCreateInputSchema.parse(await readDesktopJson(request, 16 * 1024))
            workspace(runtime, input.workspaceId)
            const result = externalMcpCreateResultSchema.parse(await createDesktopExternalMcpKey(runtime, input))
            if (result.ok && (result.key.workspaceId !== input.workspaceId || result.receipt.workspaceId !== input.workspaceId || result.receipt.requestId !== input.requestId)) throw new DesktopHttpError(409, EXTERNAL_MCP_COPY.changed)
            return json(result)
        }
        throw new DesktopHttpError(405, 'Method not allowed.')
    } catch (error) {
        return failure(error)
    }
}

async function revoke(request: Request): Promise<Response> {
    try {
        const runtime = await authenticateDesktopRequest(request)
        const input = externalMcpRevokeInputSchema.parse(await readDesktopJson(request, 16 * 1024))
        workspace(runtime, input.workspaceId)
        const result = externalMcpRevokeResultSchema.parse(await revokeDesktopExternalMcpKey(runtime, input))
        if (result.ok && (result.key.workspaceId !== input.workspaceId || result.key.keyId !== input.keyId || result.receipt.requestId !== input.requestId)) throw new DesktopHttpError(409, EXTERNAL_MCP_COPY.changed)
        return json(result)
    } catch (error) {
        return failure(error)
    }
}

async function listener(request: Request): Promise<Response> {
    try {
        const runtime = await authenticateDesktopRequest(request)
        const result = externalMcpListenerViewSchema.parse(await readDesktopExternalMcpListener(runtime))
        if (result.workspaceId !== null && result.workspaceId !== runtime.workspaceId) throw new DesktopHttpError(409, EXTERNAL_MCP_COPY.workspace)
        return json(result)
    } catch (error) {
        return failure(error)
    }
}

async function listenerControl(request: Request, action: 'enable' | 'disable'): Promise<Response> {
    try {
        const runtime = await authenticateDesktopRequest(request)
        const input = externalMcpEnableInputSchema.parse(await readDesktopJson(request, 16 * 1024))
        workspace(runtime, input.workspaceId)
        const result = externalMcpListenerResultSchema.parse(await (action === 'enable' ? enableDesktopExternalMcpListener(runtime, input) : disableDesktopExternalMcpListener(runtime, input)))
        if (result.ok && (result.receipt.requestId !== input.requestId || result.listener.workspaceId !== null && result.listener.workspaceId !== input.workspaceId)) throw new DesktopHttpError(409, EXTERNAL_MCP_COPY.changed)
        return json(result)
    } catch (error) {
        return failure(error)
    }
}

async function attempts(request: Request): Promise<Response> {
    try {
        const runtime = await authenticateDesktopRequest(request)
        const db = await openDesktopDatabase(runtime.dataRoot)
        const store = desktopExternalMcpAttemptStore(db)
        if (request.method === 'GET') {
            const workspaceId = workspace(runtime, requestedWorkspace(request))
            return json({ attempts: await store.list(workspaceId) })
        }
        const attempt: DesktopExternalMcpAttempt = desktopExternalMcpAttemptSchema.parse(await readDesktopJson(request, 16 * 1024))
        workspace(runtime, attempt.input.workspaceId)
        if (request.method === 'PUT') return json({ attempt: await store.reserve(attempt) })
        if (request.method === 'DELETE') {
            await store.clear(attempt)
            return json({ attempt: null })
        }
        throw new DesktopHttpError(405, 'Method not allowed.')
    } catch (error) {
        return failure(error)
    }
}

/**
 * Makes a key for one import: 24 hours, the import tools only, and bound to the first coworker it
 * creates. The prompt carrying the key is returned once, with the key's one-time secret.
 */
async function importKey(request: Request): Promise<Response> {
    try {
        const runtime = await authenticateDesktopRequest(request)
        const db = await openDesktopDatabase(runtime.dataRoot)
        if (request.method === 'GET') {
            workspace(runtime, requestedWorkspace(request))
            return json({ keyIds: await listDesktopImportKeyIds(db) })
        }
        if (request.method !== 'POST') throw new DesktopHttpError(405, 'Method not allowed.')
        const input = desktopImportKeyRequestSchema.parse(await readDesktopJson(request, 16 * 1024))
        workspace(runtime, input.workspaceId)
        const endpoint = externalMcpEndpoint(externalMcpListenerViewSchema.parse(await readDesktopExternalMcpListener(runtime)))
        if (!endpoint) throw new DesktopHttpError(409, 'Turn on connections from outside clients first.')
        const created = externalMcpCreateResultSchema.parse(await createDesktopExternalMcpKey(runtime, {
            requestId: input.requestId, workspaceId: input.workspaceId, name: `Import · ${importSource(input.source).label}`,
            scopes: [...DESKTOP_IMPORT_KEY_SCOPES], expiresAt: new Date(Date.now() + IMPORT_KEY_TTL_MS).toISOString(),
        }))
        if (!created.ok) return json(created, 409)
        if (created.key.workspaceId !== input.workspaceId || created.receipt.requestId !== input.requestId) throw new DesktopHttpError(409, EXTERNAL_MCP_COPY.changed)
        try {
            await markDesktopImportKey(db, created.key.keyId, input.source)
        } catch {
            // A key that could not be recorded as an import key would be an ordinary key with these
            // scopes: it is revoked before its secret is ever shown.
            await revokeDesktopExternalMcpKey(runtime, { requestId: crypto.randomUUID(), workspaceId: input.workspaceId, keyId: created.key.keyId }).catch(() => {})
            throw new DesktopHttpError(503, EXTERNAL_MCP_COPY.uncertain)
        }
        const result: DesktopImportKeyResult = {
            ok: true, key: created.key,
            prompt: created.secret ? buildImportPrompt(input.source, endpoint, null, { header: `Authorization: Bearer ${created.secret}` }) : null,
        }
        return json(result)
    } catch (error) {
        return failure(error)
    }
}

export const handleDesktopExternalMcpImport = importKey
export const handleDesktopExternalMcpKeys = keys
export const handleDesktopExternalMcpRevoke = revoke
export const handleDesktopExternalMcpListener = listener
export const handleDesktopExternalMcpListenerEnable = (request: Request) => listenerControl(request, 'enable')
export const handleDesktopExternalMcpListenerDisable = (request: Request) => listenerControl(request, 'disable')
export const handleDesktopExternalMcpAttempts = attempts
