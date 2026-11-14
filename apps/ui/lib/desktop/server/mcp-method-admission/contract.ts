import 'server-only'
import { createHmac, randomUUID } from 'node:crypto'
import type { Client } from '@libsql/client'
import { z } from 'zod'
import { desktopMcpSignInSourceSchema } from '../../../../../../packages/contracts/src/desktop-mcp-sign-in'
import { createDesktopSecretCrypto } from '../secret-requests/crypto'
import { createMcpCredentialGeneration, type McpCredentialGenerationLease } from '../mcp/credential-generation'
import type { RemoteMcpStore } from '../mcp/store'
import { abortable } from '../mcp/remote'
import { digest, parsePrivate } from '../mcp-device-custody/model'

const id = z.string().min(1).max(256)
export const signInMethodRequestSchema = z.object({
    source: desktopMcpSignInSourceSchema,
    method: z.enum(['browser', 'device']),
    approvalId: id,
}).strict()
export type SignInMethodRequest = z.infer<typeof signInMethodRequestSchema>
export const approvedSignInMethodSchema = z.object({
    workspaceId: id, owner: id, engineAgentId: id, engineSessionId: id,
    registrationId: id, revision: id, name: id, resource: z.string().url().max(8192),
    requestId: id, approvalId: id, method: z.enum(['browser', 'device']),
    credentialGeneration: id, expiresAt: z.number().int().positive(),
}).strict()
export type ApprovedSignInMethod = z.infer<typeof approvedSignInMethodSchema>
export type SignInMethodProof = { value: unknown; signal: AbortSignal; check(): void }
type Transaction = Awaited<ReturnType<Client['transaction']>>
export type SignInMethodAdmissionPorts = {
    db: Client
    store: RemoteMcpStore
    key(): Buffer
    workspaceId: string
    shutdown: AbortSignal
    /** Canonical human receipt + current source/owner authority, read with this transaction. Never model claims. */
    approved(input: SignInMethodRequest, transaction: Transaction, signal: AbortSignal): Promise<SignInMethodProof | null>
    now?: () => number
}
const recordSchema = z.object({
    selectionId: z.uuid(), input: signInMethodRequestSchema, approval: approvedSignInMethodSchema,
    state: z.enum(['selected', 'reserved', 'unknown', 'retired']),
    createdAt: z.number().int(),
}).strict().superRefine((value, ctx) => {
    if (value.input.source.agentId !== value.approval.owner || value.input.source.server.name !== value.approval.name
        || value.input.source.server.revision !== value.approval.revision || value.input.source.server.url !== value.approval.resource
        || value.input.method !== value.approval.method || value.input.approvalId !== value.approval.approvalId
        || value.approval.expiresAt <= value.createdAt || value.approval.expiresAt > value.createdAt + 1_800_000) {
        ctx.addIssue({ code: 'custom', message: 'MCP method selection identity changed' })
    }
})
type Selection = z.infer<typeof recordSchema>
type Saved = { version: number; value: Selection }
type State = 'selected' | 'unknown' | 'retired' | 'expired'
export type MethodSelectionReceipt = { selectionId: string; method: 'browser' | 'device'; state: State; created: boolean }
export type MethodReservationLease = { signal: AbortSignal; check(): void; dispose(): void }
export type MethodReservation =
    | { execute: false; receipt: MethodSelectionReceipt; lease?: never }
    | { execute: true; receipt: MethodSelectionReceipt; lease: MethodReservationLease }

export const desktopMcpMethodAdmissionSchema = `CREATE TABLE IF NOT EXISTS desktop_mcp_method_admission (
 selection_id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE,
 request_key TEXT NOT NULL, generation_slot TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('selected','reserved','unknown','retired')),
 version INTEGER NOT NULL CHECK(version > 0), sealed TEXT NOT NULL,
 UNIQUE(workspace_id,agent_id,request_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS desktop_mcp_method_one_generation
 ON desktop_mcp_method_admission(workspace_id,agent_id,generation_slot)
 WHERE state IN ('selected','reserved','unknown');`

/** Selection and one-time effect reservation only. No broker, token write, route or schema initialization. */
export function createMcpMethodAdmission(ports: SignInMethodAdmissionPorts) {
    const now = ports.now ?? Date.now, crypto = createDesktopSecretCrypto(ports.key)
    const active = new Map<string, { owner: string; controller: AbortController; dispose(): void }>()
    const invalid = new Set<string>()
    let closed = false
    const unavailable = () => new Error('MCP sign-in method admission unavailable or changed. Reconcile the same request.')
    const keyed = (value: unknown) => createHmac('sha256', ports.key()).update(JSON.stringify(['mcp-method-admission-v1', value])).digest('hex')
    const requestKey = (value: Selection) => keyed([value.approval.workspaceId, value.approval.owner, value.approval.requestId, value.input.source])
    const slot = (value: Selection) => keyed([value.approval.workspaceId, value.approval.owner, value.approval.registrationId, value.approval.revision, value.approval.credentialGeneration])
    const context = (owner: string, selectionId: string, version: number) => ({ domain: 'staging' as const, agentId: owner, key: JSON.stringify(['mcp-method-admission-v1', ports.workspaceId, selectionId]), version })
    function open(signal: AbortSignal) { signal.throwIfAborted(); ports.shutdown.throwIfAborted(); if (closed) throw unavailable() }
    function invalidate(selectionId: string) {
        invalid.add(selectionId)
        const current = active.get(selectionId)
        if (current) { current.controller.abort(); current.dispose(); active.delete(selectionId) }
    }
    async function safe<T>(work: () => Promise<T>): Promise<T> { try { return await work() } catch { throw unavailable() } }
    async function seal(value: Selection, version: number) {
        const bytes = Buffer.from(JSON.stringify(parsePrivate(recordSchema, value)))
        try { return await crypto.seal(context(value.approval.owner, value.selectionId, version), bytes) }
        finally { bytes.fill(0) }
    }
    async function read(query: Pick<Client, 'execute'>, owner: string, selectionId: string): Promise<Saved | null> {
        const row = (await query.execute({ sql: 'SELECT * FROM desktop_mcp_method_admission WHERE workspace_id=? AND agent_id=? AND selection_id=?', args: [ports.workspaceId, owner, selectionId] })).rows[0]
        if (!row) return null
        let bytes: Uint8Array | undefined
        try {
            const version = Number(row.version)
            if (!Number.isSafeInteger(version) || version < 1 || String(row.sealed).length > 131_072) throw unavailable()
            bytes = await crypto.open(context(owner, selectionId, version), String(row.sealed))
            const value = parsePrivate(recordSchema, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
            if (value.selectionId !== selectionId || value.approval.workspaceId !== ports.workspaceId || value.approval.owner !== owner
                || value.state !== row.state || requestKey(value) !== row.request_key || slot(value) !== row.generation_slot) throw unavailable()
            return { version, value }
        } finally { bytes?.fill(0) }
    }
    async function replace(tx: Transaction, saved: Saved, state: Selection['state']) {
        const value = { ...saved.value, state }, version = saved.version + 1, sealed = await seal(value, version)
        const result = await tx.execute({ sql: 'UPDATE desktop_mcp_method_admission SET state=?,version=?,sealed=? WHERE workspace_id=? AND agent_id=? AND selection_id=? AND version=?', args: [state, version, sealed, ports.workspaceId, value.approval.owner, value.selectionId, saved.version] })
        if (result.rowsAffected !== 1) throw unavailable()
        return { version, value }
    }
    function receipt(value: Selection, created = false): MethodSelectionReceipt {
        return { selectionId: value.selectionId, method: value.approval.method, created,
            state: value.state === 'reserved' || value.state === 'unknown' ? 'unknown' : value.state === 'retired' ? 'retired' : value.approval.expiresAt <= now() ? 'expired' : 'selected' }
    }
    async function authority(input: SignInMethodRequest, tx: Transaction, signal: AbortSignal) {
        const proof = await abortable(ports.approved(input, tx, signal), signal)
        if (!proof) throw unavailable()
        const approval = parsePrivate(approvedSignInMethodSchema, proof.value)
        const bound = AbortSignal.any([signal, proof.signal, AbortSignal.timeout(Math.max(1, Math.min(30_000, Math.ceil(approval.expiresAt - now()))))])
        const check = () => {
            open(bound); proof.check()
            if (approval.workspaceId !== ports.workspaceId || approval.owner !== input.source.agentId
                || approval.name !== input.source.server.name || approval.revision !== input.source.server.revision || approval.resource !== input.source.server.url
                || approval.approvalId !== input.approvalId || approval.method !== input.method || approval.expiresAt <= now()
                || approval.expiresAt > now() + 1_800_000) throw unavailable()
        }
        check()
        const generation = await createMcpCredentialGeneration({
            store: { ...ports.store, credentialState: (owner, name) => ports.store.credentialState(owner, name, tx) },
            key: ports.key, now,
        }).read(approval.owner, approval.name, bound)
        if (!generation) throw unavailable()
        try {
            check(); generation.check()
            if (generation.registrationId !== approval.registrationId || generation.revision !== approval.revision || generation.generation !== approval.credentialGeneration) throw unavailable()
        } catch { generation.dispose(); throw unavailable() }
        return { approval, generation, signal: AbortSignal.any([bound, generation.signal]), check: () => { check(); generation.check() } }
    }
    async function transaction<T>(signal: AbortSignal, work: (tx: Transaction) => Promise<T>) {
        open(signal)
        const tx = await ports.db.transaction('write')
        try { const value = await work(tx); open(signal); await tx.commit(); return value }
        catch { await tx.rollback().catch(() => {}); throw unavailable() }
        finally { tx.close() }
    }
    const api = {
        select: (raw: unknown, stop: AbortSignal) => safe(async () => {
            const input = parsePrivate(signInMethodRequestSchema, raw), signal = AbortSignal.any([stop, ports.shutdown, AbortSignal.timeout(30_000)])
            let generation: McpCredentialGenerationLease | undefined
            try { return await transaction(signal, async tx => {
                const admitted = await authority(input, tx, signal); generation = admitted.generation
                const value: Selection = { selectionId: randomUUID(), input, approval: admitted.approval, state: 'selected', createdAt: now() }
                const request = requestKey(value), target = slot(value)
                const old = (await tx.execute({ sql: 'SELECT selection_id FROM desktop_mcp_method_admission WHERE workspace_id=? AND agent_id=? AND request_key=?', args: [ports.workspaceId, value.approval.owner, request] })).rows[0]
                if (old) {
                    const saved = await read(tx, value.approval.owner, String(old.selection_id))
                    if (!saved || digest(saved.value.input) !== digest(input) || digest(saved.value.approval) !== digest(value.approval)) throw unavailable()
                    admitted.check(); return receipt(saved.value)
                }
                const count = (await tx.execute({ sql: 'SELECT COUNT(*) AS n FROM desktop_mcp_method_admission WHERE workspace_id=? AND agent_id=?', args: [ports.workspaceId, value.approval.owner] })).rows[0]
                if (Number(count?.n) >= 128) throw unavailable()
                const competing = (await tx.execute({ sql: "SELECT selection_id FROM desktop_mcp_method_admission WHERE workspace_id=? AND agent_id=? AND generation_slot=? AND state IN ('selected','reserved','unknown')", args: [ports.workspaceId, value.approval.owner, target] })).rows[0]
                if (competing) throw unavailable()
                const sealed = await seal(value, 1)
                admitted.check()
                await tx.execute({ sql: 'INSERT INTO desktop_mcp_method_admission(selection_id,workspace_id,agent_id,request_key,generation_slot,state,version,sealed) VALUES(?,?,?,?,?,?,1,?)', args: [value.selectionId, ports.workspaceId, value.approval.owner, request, target, 'selected', sealed] })
                admitted.check(); return receipt(value, true)
            }) } finally { generation?.dispose() }
        }),
        reserve: (owner: string, selectionId: string, stop: AbortSignal): Promise<MethodReservation> => safe(async () => {
            const signal = AbortSignal.any([stop, ports.shutdown, AbortSignal.timeout(30_000)])
            let admitted: Awaited<ReturnType<typeof authority>> | undefined
            let keep = false
            try {
                const result = await transaction(signal, async tx => {
                    const saved = await read(tx, owner, selectionId)
                    if (!saved) throw unavailable()
                    if (saved.value.state !== 'selected') return { execute: false as const, receipt: receipt(saved.value) }
                    admitted = await authority(saved.value.input, tx, signal)
                    if (invalid.has(selectionId) || digest(admitted.approval) !== digest(saved.value.approval)) throw unavailable()
                    const next = await replace(tx, saved, 'reserved')
                    admitted.check(); return { execute: true as const, receipt: receipt(next.value) }
                })
                if (!result.execute) return result
                const grant = admitted!, controller = new AbortController()
                const dispose = () => { controller.abort(); grant.generation.dispose(); if (active.get(selectionId)?.controller === controller) active.delete(selectionId) }
                const check = () => {
                    try { grant.check(); if (invalid.has(selectionId) || controller.signal.aborted) throw unavailable() }
                    catch { throw unavailable() }
                }
                active.set(selectionId, { owner, controller, dispose })
                try { check() } catch { invalidate(selectionId); throw unavailable() }
                keep = true
                return { ...result, lease: { signal: AbortSignal.any([grant.signal, controller.signal]), check, dispose } }
            } finally { if (!keep) admitted?.generation.dispose() }
        }),
        /** Trusted authenticated owner/lifecycle scope only. A reserved effect remains unknown. */
        retire: (owner: string, selectionId: string, stop: AbortSignal) => safe(async () => {
            const live = active.get(selectionId)
            if (live && live.owner !== owner) throw unavailable()
            if (live) invalidate(selectionId)
            const signal = AbortSignal.any([stop, ports.shutdown, AbortSignal.timeout(30_000)])
            return transaction(signal, async tx => {
                const saved = await read(tx, owner, selectionId)
                if (!saved) throw unavailable()
                invalidate(selectionId)
                const next = saved.value.state === 'retired' || saved.value.state === 'unknown' ? saved : await replace(tx, saved, saved.value.state === 'selected' ? 'retired' : 'unknown')
                return receipt(next.value)
            })
        }),
        /** Existing revoke/disable/workspace-transition owner authority supplies this scope. */
        retireOwner: (owner: string, stop: AbortSignal) => safe(async () => {
            for (const [selectionId, lease] of active) if (lease.owner === owner) invalidate(selectionId)
            const signal = AbortSignal.any([stop, ports.shutdown, AbortSignal.timeout(30_000)])
            return transaction(signal, async tx => {
                const rows = (await tx.execute({ sql: 'SELECT selection_id FROM desktop_mcp_method_admission WHERE workspace_id=? AND agent_id=? LIMIT 129', args: [ports.workspaceId, owner] })).rows
                if (rows.length > 128) throw unavailable()
                const results: MethodSelectionReceipt[] = []
                for (const row of rows) {
                    const saved = await read(tx, owner, String(row.selection_id))
                    if (!saved) throw unavailable()
                    invalidate(saved.value.selectionId)
                    const next = saved.value.state === 'retired' || saved.value.state === 'unknown' ? saved : await replace(tx, saved, saved.value.state === 'selected' ? 'retired' : 'unknown')
                    results.push(receipt(next.value))
                }
                return results
            })
        }),
        inspect: (owner: string, selectionId: string, stop: AbortSignal) => safe(async () => {
            open(stop)
            const saved = await read(ports.db, owner, selectionId)
            open(stop)
            return saved ? receipt(saved.value) : null
        }),
        dispose(): void {
            closed = true
            for (const [selectionId] of active) invalidate(selectionId)
            ports.shutdown.removeEventListener('abort', api.dispose)
        },
    }
    ports.shutdown.addEventListener('abort', api.dispose, { once: true })
    return api
}
