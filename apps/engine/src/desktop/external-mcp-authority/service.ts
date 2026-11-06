import { randomUUID } from 'node:crypto'
import {
    DESKTOP_EXTERNAL_MCP_CONTRACT_VERSION,
    EXTERNAL_MCP_ACTIVE_KEY_MAX,
    EXTERNAL_MCP_COPY,
    EXTERNAL_MCP_DEFAULT_SCOPES,
    EXTERNAL_MCP_NAME_MAX,
    EXTERNAL_MCP_PATH,
    EXTERNAL_MCP_REFUSED_SCOPES,
    externalMcpCallContextSchema,
    externalMcpCreateInputSchema,
    externalMcpEnableInputSchema,
    externalMcpKeyViewSchema,
    externalMcpLiveCheckInputSchema,
    externalMcpLiveCheckResultSchema,
    externalMcpReceiptSchema,
    externalMcpRevokeInputSchema,
    externalMcpScopeSchema,
    externalMcpToolRegistrationSchema,
    externalMcpToolResultSchema,
    type ExternalMcpCreateResult,
    type ExternalMcpDispatchPort,
    type ExternalMcpKeyView,
    type ExternalMcpListenerResult,
    type ExternalMcpListenerView,
    type ExternalMcpLiveCheckInput,
    type ExternalMcpLiveCheckResult,
    type ExternalMcpPrincipal,
    type ExternalMcpReceipt,
    type ExternalMcpRefusal,
    type ExternalMcpRevokeResult,
    type ExternalMcpToolRegistration,
    type ExternalMcpToolResult,
} from '@rerun/contracts'
import { EXTERNAL_MCP_RUNTIME_AUTHORITY, type ExternalMcpRuntimeAuthority, type ExternalMcpRuntimeSnapshot } from './authority.js'
import { externalMcpFingerprint, externalMcpKeyPrefix, hashExternalMcpSecret, mintExternalMcpSecret, sameExternalMcpSecret } from './custody.js'
import { externalMcpBearer, externalMcpHttpRefusal } from './http-guards.js'
import { externalMcpPath, openExternalMcpListener, readExternalMcpBody, type ExternalMcpSocket } from './listener.js'
import { handleExternalMcpMessage, type ExternalMcpCallFailure } from './protocol.js'
import { DESKTOP_EXTERNAL_MCP_SCHEMA_SQL } from './schema.js'

type Stmt = { sql: string; args?: Array<string | number | null> }
export type ExternalMcpDb = {
    execute(statement: Stmt): Promise<{ rows: Array<Record<string, unknown>>; rowsAffected?: number }>
    batch(statements: Stmt[], mode: 'write'): Promise<unknown>
    executeMultiple(sql: string): Promise<void>
}

type Row = Record<string, unknown>
type Listen = (onRequest: (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => Promise<void>) => Promise<ExternalMcpSocket>

const REFUSED = new Set<string>(EXTERNAL_MCP_REFUSED_SCOPES)

export function externalMcpRefusedScope(input: unknown): string | null {
    const scopes = input && typeof input === 'object' && 'scopes' in input ? (input as { scopes?: unknown }).scopes : undefined
    if (!Array.isArray(scopes)) return null
    for (const scope of scopes) {
        if (typeof scope === 'string' && REFUSED.has(scope)) return scope
    }
    return null
}

function refusal(code: ExternalMcpRefusal['code'], message: string, authority?: string): ExternalMcpRefusal {
    return authority ? { ok: false, code, message, authority } : { ok: false, code, message }
}

function cell(row: Row, key: string): string | null {
    const value = row[key]
    if (value === null || value === undefined) return null
    if (typeof value !== 'string' && typeof value !== 'number') throw new Error('External MCP row is unreadable.')
    return String(value)
}

function required(row: Row, key: string): string {
    const value = cell(row, key)
    if (value === null) throw new Error('External MCP row is unreadable.')
    return value
}

export function createExternalMcpService(deps: {
    db: () => ExternalMcpDb
    authority: ExternalMcpRuntimeAuthority
    dispatch: () => ExternalMcpDispatchPort | null
    engineKey: () => string | undefined
    now?: () => Date
    listen?: Listen
    cleanupMs?: number
}) {
    const now = deps.now ?? (() => new Date())
    const listen = deps.listen ?? openExternalMcpListener
    let ready = false
    let listener: { socket: ExternalMcpSocket; workspaceId: number; installId: string; launchNonce: string } | null = null
    const owned = new Map<string, { keyId: string; abort: () => void; done: Promise<unknown> }>()
    let listenerClosing = false
    let closingTask: Promise<void> | null = null
    const cleanupMs = deps.cleanupMs ?? 5000
    let managementTail: Promise<unknown> = Promise.resolve()
    function manage<T>(work: () => Promise<T>): Promise<T> {
        const result = managementTail.catch(() => {}).then(work)
        managementTail = result.catch(() => {})
        return result
    }

    function stamp(): string {
        return now().toISOString()
    }

    function abortOwned(keyId?: string): void {
        for (const stream of owned.values()) {
            if (keyId && stream.keyId !== keyId) continue
            stream.abort()
        }
    }

    function closeListener(): Promise<void> {
        if (closingTask) return closingTask
        listenerClosing = true
        abortOwned()
        const current = listener
        const socket = current ? Promise.resolve().then(() => current.socket.close()).then(() => {
            if (listener === current) listener = null
        }) : Promise.resolve()
        // The owned promise includes outcome persistence, not just the dispatch's return.
        // Keep both the socket and unfinished calls available for another cleanup attempt.
        const drained = Promise.allSettled([...owned.values()].map(call => call.done))
        const work = (async () => {
            let timer: ReturnType<typeof setTimeout> | undefined
            try {
                await Promise.race([
                    Promise.all([socket.catch(() => { throw new Error('External MCP cleanup is not confirmed. Retry Stop.') }), drained]),
                    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('External MCP calls have not finished stopping. Retry Stop.')), cleanupMs) }),
                ])
                listenerClosing = false
            } finally { if (timer) clearTimeout(timer) }
        })()
        closingTask = work
        void work.finally(() => { if (closingTask === work) closingTask = null }).catch(() => {})
        return work
    }

    function own<T>(keyId: string, action: (signal: AbortSignal) => Promise<T>, parent: AbortSignal): Promise<T> {
        if (listenerClosing || !listener) return Promise.reject(new Error(EXTERNAL_MCP_COPY.listenerOff))
        const id = randomUUID(), controller = new AbortController()
        const signal = AbortSignal.any([parent, controller.signal])
        // Register before yielding, including tool discovery and durable receipt publication.
        const work = Promise.resolve().then(() => { signal.throwIfAborted(); return action(signal) })
        const entry = { keyId, abort: () => controller.abort(), done: work }
        owned.set(id, entry)
        void work.finally(() => { if (owned.get(id) === entry) owned.delete(id) }).catch(() => {})
        return work
    }

    function view(): ExternalMcpListenerView {
        return {
            version: DESKTOP_EXTERNAL_MCP_CONTRACT_VERSION,
            enabled: Boolean(listener) && !listenerClosing,
            origin: listener?.socket.origin ?? null,
            path: EXTERNAL_MCP_PATH,
            workspaceId: listener?.workspaceId ?? null,
            installId: listener?.installId ?? null,
            launchNonce: listener?.launchNonce ?? null,
        }
    }

    function gate(workspaceId: number): { ok: true; snapshot: ExternalMcpRuntimeSnapshot } | ExternalMcpRefusal {
        const snapshot = deps.authority.read()
        if (!snapshot?.installId || !snapshot.launchNonce) return refusal('authority_missing', EXTERNAL_MCP_COPY.authorityMissing, EXTERNAL_MCP_RUNTIME_AUTHORITY)
        if (snapshot.stopping) return refusal('runtime_stopped', EXTERNAL_MCP_COPY.stopped)
        if (snapshot.admissionsFrozen) return refusal('admissions_frozen', EXTERNAL_MCP_COPY.frozen)
        if (snapshot.workspaceId !== workspaceId) return refusal('workspace_mismatch', EXTERNAL_MCP_COPY.workspace)
        return { ok: true, snapshot }
    }

    async function reconcile(): Promise<void> {
        if (!listener && !listenerClosing) return
        const snapshot = deps.authority.read()
        if (listenerClosing || !snapshot || snapshot.stopping || snapshot.admissionsFrozen || listener && (snapshot.workspaceId !== listener.workspaceId || snapshot.launchNonce !== listener.launchNonce || snapshot.installId !== listener.installId)) {
            await closeListener()
        }
    }

    function keyView(row: Row): ExternalMcpKeyView {
        const expiresAt = cell(row, 'expires_at')
        const revokedAt = cell(row, 'revoked_at')
        const expiresMs = expiresAt ? Date.parse(expiresAt) : Number.NaN
        const expired = Boolean(expiresAt) && !(expiresMs > now().getTime())
        const status = revokedAt ? 'revoked' : expired ? 'expired' : 'active'
        return externalMcpKeyViewSchema.parse({
            version: DESKTOP_EXTERNAL_MCP_CONTRACT_VERSION,
            keyId: required(row, 'key_id'),
            workspaceId: Number(required(row, 'workspace_id')),
            name: required(row, 'name'),
            keyPrefix: required(row, 'key_prefix'),
            scopes: externalMcpScopeSchema.array().parse(JSON.parse(required(row, 'scopes_json'))),
            status,
            expiresAt,
            revokedAt,
            createdAt: required(row, 'created_at'),
            lastUsedAt: cell(row, 'last_used_at'),
            revision: Number(required(row, 'revision')),
        })
    }

    function principalOf(row: Row, snapshot: ExternalMcpRuntimeSnapshot): ExternalMcpPrincipal {
        const key = keyView(row)
        return {
            version: DESKTOP_EXTERNAL_MCP_CONTRACT_VERSION,
            keyId: key.keyId,
            workspaceId: key.workspaceId,
            keyRevision: key.revision,
            scopes: key.scopes,
            installId: snapshot.installId,
            launchNonce: snapshot.launchNonce,
            runtimeWorkspaceId: snapshot.workspaceId,
            expiresAt: key.expiresAt,
        }
    }

    async function keyByHash(hash: string): Promise<Row | null> {
        const found = await deps.db().execute({ sql: 'SELECT * FROM desktop_external_mcp_keys WHERE key_hash = ?', args: [hash] })
        return found.rows[0] ?? null
    }

    async function keyById(keyId: string): Promise<Row | null> {
        const found = await deps.db().execute({ sql: 'SELECT * FROM desktop_external_mcp_keys WHERE key_id = ?', args: [keyId] })
        return found.rows[0] ?? null
    }

    async function receiptRow(requestId: string): Promise<Row | null> {
        const found = await deps.db().execute({ sql: 'SELECT * FROM desktop_external_mcp_receipts WHERE request_id = ?', args: [requestId] })
        return found.rows[0] ?? null
    }

    function receiptOf(row: Row): ExternalMcpReceipt {
        const receipt = externalMcpReceiptSchema.parse(JSON.parse(required(row, 'receipt_json')))
        if (receipt.requestId !== required(row, 'request_id') || receipt.fingerprint !== required(row, 'fingerprint') || receipt.kind !== required(row, 'kind')
            || required(row, 'status') !== 'pending' && receipt.status !== required(row, 'status')) throw new Error('External MCP receipt identity changed.')
        return receipt
    }

    async function saveReceipt(receipt: ExternalMcpReceipt, fingerprint: string, response: unknown): Promise<void> {
        await deps.db().execute({
            sql: `UPDATE desktop_external_mcp_receipts SET fingerprint = ?, status = ?, receipt_json = ?, response_json = ? WHERE request_id = ?`,
            args: [fingerprint, receipt.status, JSON.stringify(receipt), response === undefined ? null : JSON.stringify(response), receipt.requestId],
        })
    }

    async function insertReceipt(receipt: ExternalMcpReceipt, fingerprint: string): Promise<void> {
        await deps.db().execute({
            sql: `INSERT INTO desktop_external_mcp_receipts (request_id, fingerprint, kind, status, receipt_json, response_json, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)`,
            args: [receipt.requestId, fingerprint, receipt.kind, receipt.status, JSON.stringify(receipt), receipt.createdAt],
        })
    }

    function draftReceipt(input: { requestId: string; kind: ExternalMcpReceipt['kind']; workspaceId: number; snapshot: ExternalMcpRuntimeSnapshot; fingerprint: string; keyId?: string | null; keyRevision?: number | null; message: string; status?: ExternalMcpReceipt['status'] }): ExternalMcpReceipt {
        return {
            version: DESKTOP_EXTERNAL_MCP_CONTRACT_VERSION,
            receiptId: randomUUID(),
            requestId: input.requestId,
            kind: input.kind,
            status: input.status ?? 'recorded',
            workspaceId: input.workspaceId,
            keyId: input.keyId ?? null,
            keyRevision: input.keyRevision ?? null,
            installId: input.snapshot.installId,
            launchNonce: input.snapshot.launchNonce,
            fingerprint: input.fingerprint,
            message: input.message,
            secretAvailable: false,
            createdAt: stamp(),
        }
    }

    async function recheck(input: ExternalMcpLiveCheckInput): Promise<ExternalMcpLiveCheckResult> {
        if (!ready) return refusal('authority_missing', 'External MCP storage is not initialized.', EXTERNAL_MCP_RUNTIME_AUTHORITY)
        // A checkpoint belongs to an owned call. It must refuse a closing/frozen
        // lifetime directly, never await the drain that is waiting for this call.
        if (listenerClosing) return refusal('listener_disabled', EXTERNAL_MCP_COPY.listenerOff)
        const parsed = externalMcpLiveCheckInputSchema.safeParse(input)
        if (!parsed.success) return refusal('invalid', 'That external key check is not valid.')
        const opened = gate(parsed.data.workspaceId)
        if (!opened.ok) return opened
        if (opened.snapshot.installId !== parsed.data.installId || opened.snapshot.launchNonce !== parsed.data.launchNonce) {
            return refusal('revision_changed', EXTERNAL_MCP_COPY.changed)
        }
        const row = await keyById(parsed.data.keyId)
        const current = gate(parsed.data.workspaceId)
        if (!current.ok) return current
        if (current.snapshot.installId !== parsed.data.installId || current.snapshot.launchNonce !== parsed.data.launchNonce) return refusal('revision_changed', EXTERNAL_MCP_COPY.changed)
        if (!row || Number(required(row, 'workspace_id')) !== parsed.data.workspaceId) return refusal('not_found', 'Key not found')
        const key = keyView(row)
        if (key.status === 'revoked') return refusal('revoked', EXTERNAL_MCP_COPY.revoked)
        if (key.status === 'expired') return refusal('expired', EXTERNAL_MCP_COPY.expired)
        if (key.revision !== parsed.data.keyRevision) return refusal('revision_changed', EXTERNAL_MCP_COPY.changed)
        const scopes = [...parsed.data.scopes].sort().join()
        if ([...key.scopes].sort().join() !== scopes) return refusal('scope_missing', 'This key does not include that access.')
        return externalMcpLiveCheckResultSchema.parse({ ok: true, principal: principalOf(row, current.snapshot) })
    }

    function checkInput(principal: ExternalMcpPrincipal, requestId: string): ExternalMcpLiveCheckInput {
        const { keyId,workspaceId,keyRevision,installId,launchNonce,scopes } = principal
        return { keyId,workspaceId,keyRevision,installId,launchNonce,scopes,requestId }
    }

    async function visibleTools(principal: ExternalMcpPrincipal): Promise<ExternalMcpToolRegistration[]> {
        const live = await recheck(checkInput(principal,randomUUID()))
        if (!live.ok) throw Object.assign(new Error(live.message), { code: live.code })
        const dispatch = deps.dispatch()
        if (!dispatch) throw Object.assign(new Error(EXTERNAL_MCP_COPY.adapterMissing), { code: 'adapter_missing' })
        let tools: ExternalMcpToolRegistration[]
        try {
            tools = externalMcpToolRegistrationSchema.array().parse(await dispatch.listTools(live.principal))
        } catch (error) {
            if (error instanceof Error && error.message === EXTERNAL_MCP_COPY.adapterMissing) throw error
            throw Object.assign(new Error(EXTERNAL_MCP_COPY.adapterMissing), { code: 'adapter_missing' })
        }
        return tools.filter(tool => live.principal.scopes.includes(tool.scope))
    }

    async function performCallTool(principal: ExternalMcpPrincipal, requestId: string | null, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ExternalMcpToolResult | ExternalMcpCallFailure> {
        let tools: ExternalMcpToolRegistration[]
        try {
            tools = await visibleTools(principal)
        } catch (error) {
            const code = error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'uncertain'
            const message = error instanceof Error && error.message ? error.message : EXTERNAL_MCP_COPY.uncertain
            const status = code === 'adapter_missing' || code === 'authority_missing' ? 503 : code === 'unauthorized' || code === 'expired' || code === 'revoked' ? 401 : code === 'uncertain' ? 200 : 403
            return { ok: false, status, code, message }
        }
        const tool = tools.find(item => item.name === name)
        if (!tool) return { ok: false, status: 200, code: 'unsupported', message: 'Unknown tool.' }
        if (!principal.scopes.includes(tool.scope)) return { ok: false, status: 403, code: 'scope_missing', message: 'This key does not include that access.' }
        const dispatch = deps.dispatch()
        if (!dispatch) return { ok: false, status: 503, code: 'adapter_missing', message: EXTERNAL_MCP_COPY.adapterMissing }
        const live = await recheck(checkInput(principal,requestId && /^[0-9a-f-]{36}$/i.test(requestId) ? requestId : randomUUID()))
        if (!live.ok) return { ok: false, status: 401, code: live.code, message: live.message }
        if (!tool.effect) {
            const read = await runCall(dispatch, live.principal, name, args, signal, null)
            return read.ok ? read.value : read
        }
        if (!requestId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
            return { ok: false, status: 400, code: 'invalid', message: 'This effect needs a request id. It was not run.' }
        }
        const fingerprint = externalMcpFingerprint({ kind: 'operation', tool: name, arguments: args, keyId: live.principal.keyId, keyRevision: live.principal.keyRevision, workspaceId: live.principal.workspaceId, installId: live.principal.installId })
        const existing = await receiptRow(requestId)
        if (existing) {
            if (required(existing, 'fingerprint') !== fingerprint) return { ok: false, status: 409, code: 'replay_conflict', message: EXTERNAL_MCP_COPY.changed }
            const receipt = receiptOf(existing)
            if (receipt.kind !== 'operation' || receipt.keyId !== live.principal.keyId || receipt.workspaceId !== live.principal.workspaceId || receipt.installId !== live.principal.installId) return { ok: false, status: 409, code: 'replay_conflict', message: EXTERNAL_MCP_COPY.changed }
            if (required(existing, 'status') === 'pending') return { ok: false, status: 409, code: 'in_flight', message: EXTERNAL_MCP_COPY.inFlight }
            const stored = cell(existing, 'response_json')
            if (!stored || required(existing, 'status') !== 'recorded') return { ok: false, status: 200, code: 'uncertain', message: EXTERNAL_MCP_COPY.uncertain }
            return externalMcpToolResultSchema.parse(JSON.parse(stored))
        }
        const receipt = draftReceipt({ requestId, kind: 'operation', workspaceId: live.principal.workspaceId, snapshot: { installId: live.principal.installId, launchNonce: live.principal.launchNonce, workspaceId: live.principal.runtimeWorkspaceId, admissionsFrozen: false, stopping: false }, fingerprint, keyId: live.principal.keyId, keyRevision: live.principal.keyRevision, message: EXTERNAL_MCP_COPY.inFlight, status: 'uncertain' })
        await insertReceipt(receipt, fingerprint)
        await deps.db().execute({ sql: `UPDATE desktop_external_mcp_receipts SET status = 'pending' WHERE request_id = ?`, args: [requestId] })
        const outcome = await runCall(dispatch, live.principal, name, args, signal, requestId)
        const finished: ExternalMcpReceipt = { ...receipt, status: outcome.ok ? 'recorded' : 'uncertain', message: outcome.ok ? 'External tool call recorded.' : EXTERNAL_MCP_COPY.uncertain }
        await deps.db().execute({
            sql: `UPDATE desktop_external_mcp_receipts SET status = ?, receipt_json = ?, response_json = ? WHERE request_id = ? AND status = 'pending'`,
            args: [finished.status, JSON.stringify(finished), outcome.ok ? JSON.stringify(outcome.value) : null, requestId],
        })
        if (!outcome.ok) return { ok: false, status: 200, code: 'uncertain', message: EXTERNAL_MCP_COPY.uncertain }
        return outcome.value
    }

    async function runCall(dispatch: ExternalMcpDispatchPort, principal: ExternalMcpPrincipal, name: string, args: Record<string, unknown>, signal: AbortSignal, requestId: string | null): Promise<{ ok: true; value: ExternalMcpToolResult } | ExternalMcpCallFailure> {
        const id = requestId ?? randomUUID()
        const linked = signal
        try {
            const before = await recheck(checkInput(principal,requestId && requestId.length === 36 ? requestId : randomUUID()))
            if (!before.ok || linked.aborted) return { ok: false, status: 401, code: before.ok ? 'revoked' : before.code, message: before.ok ? EXTERNAL_MCP_COPY.revoked : before.message }
            const context = externalMcpCallContextSchema.parse({ version: DESKTOP_EXTERNAL_MCP_CONTRACT_VERSION, requestId: requestId ?? id, fingerprint: externalMcpFingerprint({ tool: name, arguments: args, keyId: principal.keyId, keyRevision: principal.keyRevision }), principal: before.principal, tool: name, arguments: args })
            const value = externalMcpToolResultSchema.parse(await dispatch.callTool(context, linked))
            const after = await recheck(checkInput(before.principal,context.requestId))
            if (linked.aborted || !after.ok) return { ok: false, status: 401, code: 'revoked', message: after.ok ? EXTERNAL_MCP_COPY.revoked : after.message }
            return { ok: true, value }
        } catch {
            return { ok: false, status: 200, code: 'uncertain', message: EXTERNAL_MCP_COPY.uncertain }
        }
    }

    const api = {
        async initialize(): Promise<void> {
            await closeListener()
            await deps.db().executeMultiple(DESKTOP_EXTERNAL_MCP_SCHEMA_SQL)
            const pending = await deps.db().execute({ sql: `SELECT request_id, receipt_json FROM desktop_external_mcp_receipts WHERE status = 'pending'`, args: [] }).catch(() => ({ rows: [] }))
            for (const row of pending.rows) {
                const receipt = externalMcpReceiptSchema.parse({ ...JSON.parse(required(row, 'receipt_json')), status: 'uncertain', message: EXTERNAL_MCP_COPY.uncertain, secretAvailable: false })
                await deps.db().execute({
                    sql: `UPDATE desktop_external_mcp_receipts SET status = 'uncertain', receipt_json = ? WHERE request_id = ? AND status = 'pending'`,
                    args: [JSON.stringify(receipt), required(row, 'request_id')],
                })
            }
            ready = true
        },
        recheck,
        async list(workspaceId: number) {
            if (!ready) return refusal('authority_missing', 'External MCP storage is not initialized.', EXTERNAL_MCP_RUNTIME_AUTHORITY)
            const opened = gate(workspaceId)
            if (!opened.ok) return opened
            const rows = await deps.db().execute({
                sql: `SELECT * FROM desktop_external_mcp_keys WHERE workspace_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`,
                args: [workspaceId],
            })
            const keys = rows.rows.map(keyView).filter(key => key.status !== 'revoked')
            const ordered = [...keys.filter(key => key.status === 'active'), ...keys.filter(key => key.status !== 'active')]
            return { version: DESKTOP_EXTERNAL_MCP_CONTRACT_VERSION, workspaceId, keys: ordered.slice(0, EXTERNAL_MCP_ACTIVE_KEY_MAX) }
        },
        async create(input: unknown): Promise<ExternalMcpCreateResult> {
            if (!ready) return refusal('authority_missing', 'External MCP storage is not initialized.', EXTERNAL_MCP_RUNTIME_AUTHORITY)
            if (externalMcpRefusedScope(input)) return refusal('scope_refused', 'That access cannot be granted to an external key.')
            const parsed = externalMcpCreateInputSchema.safeParse(input)
            if (!parsed.success) return refusal('invalid', 'That external key could not be created.')
            const name = parsed.data.name.trim()
            if (!name) return refusal('name_required', EXTERNAL_MCP_COPY.nameRequired)
            if (name.length > EXTERNAL_MCP_NAME_MAX) return refusal('name_too_long', EXTERNAL_MCP_COPY.nameTooLong)
            if (parsed.data.expiresAt && Date.parse(parsed.data.expiresAt) <= now().getTime()) return refusal('invalid', 'Choose an expiry in the future, or leave the key without one.')
            const opened = gate(parsed.data.workspaceId)
            if (!opened.ok) return opened
            const fingerprint = externalMcpFingerprint({ kind: 'create', workspaceId: parsed.data.workspaceId, name, scopes: parsed.data.scopes, expiresAt: parsed.data.expiresAt })
            const existing = await receiptRow(parsed.data.requestId)
            if (existing) {
                if (required(existing, 'fingerprint') !== fingerprint) return refusal('replay_conflict', EXTERNAL_MCP_COPY.changed)
                const key = await deps.db().execute({ sql: 'SELECT * FROM desktop_external_mcp_keys WHERE create_request_id = ?', args: [parsed.data.requestId] })
                if (!key.rows[0]) return refusal('uncertain', EXTERNAL_MCP_COPY.uncertain)
                return { ok: true, recovered: true, secretAvailable: false, secret: null, key: keyView(key.rows[0]), receipt: receiptOf(existing), message: EXTERNAL_MCP_COPY.secretDiscarded }
            }
            const active = await deps.db().execute({
                sql: `SELECT key_id, expires_at FROM desktop_external_mcp_keys WHERE workspace_id = ? AND revoked_at IS NULL`,
                args: [parsed.data.workspaceId],
            })
            const activeCount = active.rows.filter(row => {
                const expires = cell(row, 'expires_at')
                return !expires || Date.parse(expires) > now().getTime()
            }).length
            if (activeCount >= EXTERNAL_MCP_ACTIVE_KEY_MAX) return refusal('too_many_keys', EXTERNAL_MCP_COPY.tooMany)
            const secret = mintExternalMcpSecret(deps.engineKey())
            const keyId = randomUUID()
            const createdAt = stamp()
            const scopes = parsed.data.scopes.length ? parsed.data.scopes : [...EXTERNAL_MCP_DEFAULT_SCOPES]
            const pendingReceipt = draftReceipt({ requestId: parsed.data.requestId, kind: 'create', workspaceId: parsed.data.workspaceId, snapshot: opened.snapshot, fingerprint, keyId, keyRevision: 1, message: EXTERNAL_MCP_COPY.inFlight, status: 'uncertain' })
            try {
                await deps.db().batch([
                    { sql: `INSERT INTO desktop_external_mcp_keys (key_id, workspace_id, name, key_prefix, key_hash, scopes_json, expires_at, revoked_at, created_at, last_used_at, revision, secret_delivered, create_request_id) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, 1, 0, ?)`, args: [keyId, parsed.data.workspaceId, name, externalMcpKeyPrefix(secret), hashExternalMcpSecret(secret), JSON.stringify(scopes), parsed.data.expiresAt, createdAt, parsed.data.requestId] },
                    { sql: `INSERT INTO desktop_external_mcp_receipts (request_id, fingerprint, kind, status, receipt_json, response_json, created_at) VALUES (?, ?, 'create', 'pending', ?, NULL, ?)`, args: [parsed.data.requestId, fingerprint, JSON.stringify(pendingReceipt), createdAt] },
                ], 'write')
            } catch {
                const again = await receiptRow(parsed.data.requestId)
                const stored = again ? (await deps.db().execute({ sql: 'SELECT * FROM desktop_external_mcp_keys WHERE create_request_id = ?', args: [parsed.data.requestId] })).rows[0] : undefined
                if (!again || !stored) return refusal('uncertain', EXTERNAL_MCP_COPY.uncertain)
                if (required(again, 'fingerprint') !== fingerprint) return refusal('replay_conflict', EXTERNAL_MCP_COPY.changed)
                return { ok: true, recovered: true, secretAvailable: false, secret: null, key: keyView(stored), receipt: receiptOf(again), message: EXTERNAL_MCP_COPY.secretDiscarded }
            }
            const won = await deps.db().execute({ sql: `UPDATE desktop_external_mcp_keys SET secret_delivered = 1 WHERE key_id = ? AND secret_delivered = 0`, args: [keyId] })
            const secretAvailable = Number(won.rowsAffected ?? 0) === 1
            const row = (await keyById(keyId))!
            const receipt = draftReceipt({ requestId: parsed.data.requestId, kind: 'create', workspaceId: parsed.data.workspaceId, snapshot: opened.snapshot, fingerprint, keyId, keyRevision: 1, message: secretAvailable ? 'External key created.' : EXTERNAL_MCP_COPY.secretDiscarded })
            await saveReceipt(receipt, fingerprint, null)
            return { ok: true, recovered: !secretAvailable, secretAvailable, secret: secretAvailable ? secret : null, key: keyView(row), receipt, message: receipt.message }
        },
        async revoke(input: unknown): Promise<ExternalMcpRevokeResult> {
            if (!ready) return refusal('authority_missing', 'External MCP storage is not initialized.', EXTERNAL_MCP_RUNTIME_AUTHORITY)
            const parsed = externalMcpRevokeInputSchema.safeParse(input)
            if (!parsed.success) return refusal('invalid', 'That key could not be revoked.')
            const opened = gate(parsed.data.workspaceId)
            if (!opened.ok) return opened
            const fingerprint = externalMcpFingerprint({ kind: 'revoke', workspaceId: parsed.data.workspaceId, keyId: parsed.data.keyId })
            const existing = await receiptRow(parsed.data.requestId)
            if (existing) {
                if (required(existing, 'fingerprint') !== fingerprint) return refusal('replay_conflict', EXTERNAL_MCP_COPY.changed)
                const row = await keyById(parsed.data.keyId)
                if (!row) return refusal('not_found', 'Key not found')
                return { ok: true, recovered: true, key: keyView(row), receipt: receiptOf(existing) }
            }
            const row = await keyById(parsed.data.keyId)
            if (!row || Number(required(row, 'workspace_id')) !== parsed.data.workspaceId) return refusal('not_found', 'Key not found')
            const current = keyView(row)
            if (current.status !== 'revoked') {
                await deps.db().execute({ sql: `UPDATE desktop_external_mcp_keys SET revoked_at = ?, revision = revision + 1 WHERE key_id = ? AND revoked_at IS NULL`, args: [stamp(), parsed.data.keyId] })
                abortOwned(parsed.data.keyId)
            }
            const next = keyView((await keyById(parsed.data.keyId))!)
            const receipt = draftReceipt({ requestId: parsed.data.requestId, kind: 'revoke', workspaceId: parsed.data.workspaceId, snapshot: opened.snapshot, fingerprint, keyId: next.keyId, keyRevision: next.revision, message: current.status === 'revoked' ? 'This key was already revoked.' : `${next.name} revoked` })
            await insertReceipt(receipt, fingerprint)
            return { ok: true, recovered: false, key: next, receipt }
        },
        listener: async (): Promise<ExternalMcpListenerView> => {
            await reconcile()
            return view()
        },
        async enable(input: unknown): Promise<ExternalMcpListenerResult> {
            if (!ready) return refusal('authority_missing', 'External MCP storage is not initialized.', EXTERNAL_MCP_RUNTIME_AUTHORITY)
            const parsed = externalMcpEnableInputSchema.safeParse(input)
            if (!parsed.success) return refusal('invalid', 'The local listener could not be started.')
            await reconcile()
            const opened = gate(parsed.data.workspaceId)
            if (!opened.ok) return opened
            const fingerprint = externalMcpFingerprint({ kind: 'enable', workspaceId: parsed.data.workspaceId })
            const existing = await receiptRow(parsed.data.requestId)
            if (existing) {
                if (required(existing, 'fingerprint') !== fingerprint) return refusal('replay_conflict', EXTERNAL_MCP_COPY.changed)
                return { ok: true, recovered: true, listener: view(), receipt: receiptOf(existing) }
            }
            if (!listener) {
                const socket = await listen((request, response) => handle(request, response))
                if (!socket.origin.startsWith('http://127.0.0.1:')) {
                    await socket.close().catch(() => undefined)
                    return refusal('forbidden_host', 'This listener only answers its loopback host.')
                }
                const current = gate(parsed.data.workspaceId)
                if (!current.ok || current.snapshot.installId !== opened.snapshot.installId || current.snapshot.launchNonce !== opened.snapshot.launchNonce) {
                    await socket.close()
                    return current.ok ? refusal('revision_changed', EXTERNAL_MCP_COPY.changed) : current
                }
                listener = { socket, workspaceId: opened.snapshot.workspaceId, installId: opened.snapshot.installId, launchNonce: opened.snapshot.launchNonce }
            }
            const receipt = draftReceipt({ requestId: parsed.data.requestId, kind: 'enable', workspaceId: parsed.data.workspaceId, snapshot: opened.snapshot, fingerprint, message: 'Local MCP listener is on for this workspace.' })
            await insertReceipt(receipt, fingerprint)
            return { ok: true, recovered: false, listener: view(), receipt }
        },
        async disable(input: unknown): Promise<ExternalMcpListenerResult> {
            if (!ready) return refusal('authority_missing', 'External MCP storage is not initialized.', EXTERNAL_MCP_RUNTIME_AUTHORITY)
            const parsed = externalMcpEnableInputSchema.safeParse(input)
            if (!parsed.success) return refusal('invalid', 'The local listener could not be stopped.')
            const opened = gate(parsed.data.workspaceId)
            if (!opened.ok) return opened
            const fingerprint = externalMcpFingerprint({ kind: 'disable', workspaceId: parsed.data.workspaceId })
            const existing = await receiptRow(parsed.data.requestId)
            if (existing) {
                if (required(existing, 'fingerprint') !== fingerprint) return refusal('replay_conflict', EXTERNAL_MCP_COPY.changed)
                return { ok: true, recovered: true, listener: view(), receipt: receiptOf(existing) }
            }
            await closeListener()
            const receipt = draftReceipt({ requestId: parsed.data.requestId, kind: 'disable', workspaceId: parsed.data.workspaceId, snapshot: opened.snapshot, fingerprint, message: EXTERNAL_MCP_COPY.listenerOff })
            await insertReceipt(receipt, fingerprint)
            return { ok: true, recovered: false, listener: view(), receipt }
        },
        async admit(token: string | null): Promise<{ ok: true; principal: ExternalMcpPrincipal } | ExternalMcpRefusal> {
            if (!ready) return refusal('listener_disabled', EXTERNAL_MCP_COPY.listenerOff)
            await reconcile()
            return createHandleAdmit(token)
        },
        async handle(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse): Promise<void> {
            await handle(request, response)
        },
        async close(): Promise<void> {
            await closeListener()
        },
    }

    return {
        ...api,
        create: (input: unknown) => manage(() => api.create(input)),
        revoke: (input: unknown) => manage(() => api.revoke(input)),
        enable: (input: unknown) => manage(() => api.enable(input)),
        disable: (input: unknown) => manage(() => api.disable(input)),
        close: () => manage(() => api.close()),
    }

    async function handle(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse): Promise<void> {
        const send = (status: number, body: unknown) => {
            const payload = body === null ? '' : JSON.stringify(body)
            response.writeHead(status, { 'content-type': body === null ? 'text/plain' : 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(payload) })
            response.end(payload)
        }
        await reconcile()
        if (!listener) return send(503, refusal('listener_disabled', EXTERNAL_MCP_COPY.listenerOff))
        const url = externalMcpPath(request.url)
        const blocked = externalMcpHttpRefusal({
            host: request.headers.host ?? null,
            origin: typeof request.headers.origin === 'string' ? request.headers.origin : null,
            path: url.path,
            search: url.search,
            remoteAddress: request.socket.remoteAddress,
            boundHost: new URL(listener.socket.origin).host,
        })
        if (blocked) return send(blocked.code === 'forbidden_url' ? 400 : 403, blocked)
        if (request.method !== 'POST') return send(405, { ok: false, code: 'unsupported', message: 'External MCP accepts POST only.' })
        const admitted = await admitToken(externalMcpBearer(request.headers.authorization ?? null))
        if (!admitted.ok) return send(admitted.code === 'unauthorized' || admitted.code === 'expired' || admitted.code === 'revoked' ? 401 : 403, admitted)
        let raw: unknown
        try {
            raw = await readExternalMcpBody(request)
        } catch {
            return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
        }
        const header = request.headers['x-rerun-external-request-id']
        const requestId = typeof header === 'string' ? header : null
        const inbound = new AbortController()
        request.once('aborted', () => inbound.abort())
        const rpc = await handleExternalMcpMessage(raw, {
            listTools: () => own(admitted.principal.keyId, async signal => { const tools = await visibleTools(admitted.principal); signal.throwIfAborted(); return tools }, inbound.signal),
            callTool: (name, args) => own(admitted.principal.keyId, signal => performCallTool(admitted.principal, requestId, name, args, signal), inbound.signal),
        })
        send(rpc.status, rpc.body)
    }

    async function admitToken(token: string | null) {
        return createHandleAdmit(token)
    }

    async function createHandleAdmit(token: string | null) {
        if (!listener || listenerClosing) return refusal('listener_disabled', EXTERNAL_MCP_COPY.listenerOff)
        const engineKey = deps.engineKey()
        if (!token || !token.startsWith('rk_') || (engineKey ? sameExternalMcpSecret(token, engineKey) : false)) return refusal('unauthorized', EXTERNAL_MCP_COPY.unauthorized)
        const row = await keyByHash(hashExternalMcpSecret(token))
        if (!listener || listenerClosing) return refusal('listener_disabled', EXTERNAL_MCP_COPY.listenerOff)
        if (!row) return refusal('unauthorized', EXTERNAL_MCP_COPY.unauthorized)
        const key = keyView(row)
        if (key.workspaceId !== listener.workspaceId) return refusal('workspace_mismatch', EXTERNAL_MCP_COPY.workspace)
        if (key.status === 'revoked') return refusal('revoked', EXTERNAL_MCP_COPY.revoked)
        if (key.status === 'expired') return refusal('expired', EXTERNAL_MCP_COPY.expired)
        const opened = gate(key.workspaceId)
        if (!opened.ok) return opened
        void deps.db().execute({ sql: `UPDATE desktop_external_mcp_keys SET last_used_at = ? WHERE key_id = ? AND revoked_at IS NULL`, args: [stamp(), key.keyId] }).catch(() => undefined)
        return { ok: true as const, principal: principalOf(row, opened.snapshot) }
    }
}
