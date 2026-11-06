import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import type { Client } from '@libsql/client'
import { z } from 'zod'
import { desktopMcpSseConfigurationSchema, desktopMcpSseRefSchema, type DesktopMcpSseMutationResult } from '@rerun/contracts'
import type { RemoteMcpStore } from '../mcp/store'
import { endpoint } from '../mcp/model'
import { SseFailure } from './errors'

const id = z.string().min(1).max(200)
export const sseSettingsMutationSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('save'), agentId: id, requestId: z.string().uuid(), serverId: id.nullable(), expectedRevision: id.nullable(), configuration: desktopMcpSseConfigurationSchema }).strict(),
    z.object({ kind: z.literal('delete'), agentId: id, requestId: z.string().uuid(), reference: desktopMcpSseRefSchema }).strict(),
])
type Mutation = z.infer<typeof sseSettingsMutationSchema>
type Authority = (owner: string, signal: AbortSignal) => Promise<() => void>

export function createSseSettings(db: Client, store: RemoteMcpStore, authorize: Authority, drain: (owner: string, serverId?: string) => Promise<void>) {
    const tails = new Map<string, Promise<void>>()
    const serial = <T>(owner: string, work: () => Promise<T>) => {
        const next = (tails.get(owner) ?? Promise.resolve()).then(work, work)
        const tail = next.then(() => {}, () => {})
        tails.set(owner, tail)
        void tail.then(() => { if (tails.get(owner) === tail) tails.delete(owner) })
        return next
    }
    async function lookup(owner: string, requestId: string) {
        return (await db.execute({ sql: 'SELECT * FROM desktop_mcp_sse_settings WHERE owner=? AND request_id=?', args: [owner, requestId] })).rows[0]
    }
    async function perform(input: Mutation, fingerprint: string, signal: AbortSignal): Promise<DesktopMcpSseMutationResult> {
        const initial = await authorize(input.agentId, signal); initial(); signal.throwIfAborted()
        let row = await lookup(input.agentId, input.requestId)
        if (!row) {
            await db.execute({
                sql: 'INSERT INTO desktop_mcp_sse_settings(owner,request_id,fingerprint,request,server_id,revision) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING',
                args: [input.agentId, input.requestId, fingerprint, JSON.stringify(input), input.kind === 'save' ? input.serverId ?? randomUUID() : input.reference.serverId, randomUUID()],
            })
            row = await lookup(input.agentId, input.requestId)
        }
        if (!row || row.fingerprint !== fingerprint) throw new SseFailure('changed')
        if (row.result) return JSON.parse(String(row.result)) as DesktopMcpSseMutationResult
        const name = input.kind === 'save' ? input.configuration.name : input.reference.name
        return store.lifecycle.mutate(input.agentId, name, async () => {
            await drain(input.agentId, String(row!.server_id))
            initial(); signal.throwIfAborted()
            const guard = await authorize(input.agentId, signal)
            const tx = await db.transaction('write')
            try {
                const saved = (await tx.execute({ sql: 'SELECT * FROM desktop_mcp_sse_settings WHERE owner=? AND request_id=?', args: [input.agentId, input.requestId] })).rows[0]
                if (!saved || saved.fingerprint !== fingerprint) throw new SseFailure('changed')
                if (saved.result) { await tx.commit(); return JSON.parse(String(saved.result)) as DesktopMcpSseMutationResult }
                const current = (await tx.execute({ sql: 'SELECT id,revision,transport FROM desktop_remote_mcp WHERE agent_id=? AND name=?', args: [input.agentId, name] })).rows[0]
                const expectedId = input.kind === 'save' ? input.serverId : input.reference.serverId
                const expectedRevision = input.kind === 'save' ? input.expectedRevision : input.reference.expectedRevision
                let result: DesktopMcpSseMutationResult
                if ((expectedId === null) !== (expectedRevision === null) || expectedId === null && current || expectedId !== null && (!current || current.id !== expectedId || current.revision !== expectedRevision || current.transport !== 'sse')) {
                    result = { requestId: input.requestId, status: 'not-saved', message: 'The server changed. Reload its current settings.' }
                } else if (input.kind === 'save') {
                    const url = endpoint(input.configuration.url)
                    if (url !== input.configuration.url) throw new SseFailure('unsupported')
                    const serverId = String(saved.server_id), revision = String(saved.revision)
                    if (current) await tx.execute({ sql: 'UPDATE desktop_remote_mcp SET url=?,revision=? WHERE agent_id=? AND name=? AND id=? AND revision=?', args: [url, revision, input.agentId, name, expectedId, expectedRevision] })
                    else {
                        const count = Number((await tx.execute({ sql: 'SELECT COUNT(*) AS total FROM desktop_remote_mcp WHERE agent_id=?', args: [input.agentId] })).rows[0].total)
                        if (count >= 16) throw new SseFailure('unavailable')
                        await tx.execute({ sql: "INSERT INTO desktop_remote_mcp(id,transport,agent_id,name,url,revision) VALUES(?,'sse',?,?,?,?)", args: [serverId, input.agentId, name, url, revision] })
                    }
                    result = { requestId: input.requestId, status: 'saved', reference: { agentId: input.agentId, serverId, name, expectedRevision: revision } }
                } else {
                    await tx.execute({ sql: 'DELETE FROM desktop_remote_mcp_oauth WHERE agent_id=? AND name=?', args: [input.agentId, name] })
                    await tx.execute({ sql: 'DELETE FROM desktop_remote_mcp WHERE agent_id=? AND name=? AND id=? AND revision=?', args: [input.agentId, name, expectedId, expectedRevision] })
                    result = { requestId: input.requestId, status: 'saved' }
                }
                const fresh = await authorize(input.agentId, signal); initial(); guard(); fresh(); signal.throwIfAborted()
                await tx.execute({ sql: 'UPDATE desktop_mcp_sse_settings SET result=? WHERE owner=? AND request_id=? AND fingerprint=? AND result IS NULL', args: [JSON.stringify(result), input.agentId, input.requestId, fingerprint] })
                guard(); fresh(); signal.throwIfAborted()
                await tx.commit()
                return result
            } catch (error) { await tx.rollback(); throw error } finally { tx.close() }
        })
    }
    return {
        mutate(raw: unknown, signal: AbortSignal) {
            const input = sseSettingsMutationSchema.parse(raw)
            if (input.kind === 'delete' && input.reference.agentId !== input.agentId) throw new SseFailure('changed')
            if (input.kind === 'save') endpoint(input.configuration.url)
            const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex')
            return serial(input.agentId, () => perform(input, fingerprint, signal))
        },
        reconcile(owner: string, requestId: string, signal: AbortSignal) {
            return serial(owner, async (): Promise<DesktopMcpSseMutationResult> => {
                const guard = await authorize(owner, signal); guard()
                const row = await lookup(owner, requestId); guard(); signal.throwIfAborted()
                if (!row) return { requestId, status: 'not-saved' }
                if (row.result) return JSON.parse(String(row.result)) as DesktopMcpSseMutationResult
                const input = sseSettingsMutationSchema.parse(JSON.parse(String(row.request)))
                if (input.agentId !== owner || input.requestId !== requestId) throw new SseFailure('changed')
                return perform(input, String(row.fingerprint), signal)
            })
        },
    }
}
