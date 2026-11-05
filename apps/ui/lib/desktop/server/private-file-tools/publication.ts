import 'server-only'
import { createHash } from 'node:crypto'
import type { Client, Row } from '@libsql/client'
import { z } from 'zod'
import { readPrivateCoworkerFile, saveCoworkerFile, importCoworkerFile } from '../coworker-files'
import type { DesktopRuntime } from '../runtime'
import { abortable } from '../mcp/remote'
import { boundedPrivateText, editPrivateText, privateTextPath } from './semantics'
import type { PrivateFileSnapshot } from './snapshot'
export { privateFileReceiptSchema, ensureDesktopPrivateFileToolsSchema } from './schema'

const id = z.string().min(1).max(200)
export const privateFileCall = z.object({
    engineAgentId: id, sessionId: id, runId: id, toolCallId: id, tool: z.enum(['fs_write', 'fs_edit']),
    arguments: z.union([
        z.object({path: z.string(), content: z.string()}).strict(),
        z.object({path: z.string(), oldString: z.string(), newString: z.string(), replaceAll: z.boolean().optional()}).strict(),
    ]),
}).strict()
export type PrivateFileCall = z.infer<typeof privateFileCall>
export type PrivateFileAuthority = (call: PrivateFileCall, signal: AbortSignal) => Promise<{owner: string; runtime: DesktopRuntime}>
const resultSchema = z.object({status: z.enum(['saved', 'unchanged', 'unknown']), path: z.string(), message: z.string()}).strict()
type Result = z.infer<typeof resultSchema>
const unknown = (path: string): Result => ({status: 'unknown', path,
    message: 'No save acknowledgement is available. Inspect Files; this exact call will not be published again if it was claimed.'})

export function privateFilePublisher(db: Client, authorize: PrivateFileAuthority) {
    const pending = new Map<string, {digest: string; result: Promise<Result>}>()
    return async (input: PrivateFileCall, stop: AbortSignal): Promise<Result> => {
        const call = privateFileCall.parse(input)
        const signal = AbortSignal.any([stop, AbortSignal.timeout(30_000)])
        const authority = await abortable(authorize(call, signal), signal)
        const guard = async () => {
            signal.throwIfAborted()
            const now = await abortable(authorize(call, signal), signal)
            signal.throwIfAborted()
            if (now.owner !== authority.owner || now.runtime.dataRoot !== authority.runtime.dataRoot ||
                now.runtime.launchNonce !== authority.runtime.launchNonce) throw new Error('Private file owner changed')
        }
        await guard()
        const path = privateTextPath(call.arguments.path)
        if (call.tool === 'fs_write' && !('content' in call.arguments) || call.tool === 'fs_edit' && !('oldString' in call.arguments)) {
            throw new Error('Tool arguments do not match')
        }
        if (Buffer.byteLength(JSON.stringify(call.arguments)) > 2 * 1024 * 1024) throw new Error('Private file arguments exceed limit')
        const digest = createHash('sha256').update(JSON.stringify([call.engineAgentId, call.sessionId, call.runId, call.tool, call.arguments])).digest('hex')
        const key = JSON.stringify([authority.owner, call.runId, call.toolCallId])
        const args = [authority.owner, call.runId, call.toolCallId]
        const readReceipt = async () => (await db.execute({sql: 'SELECT * FROM desktop_private_file_calls WHERE owner=? AND run_id=? AND call_id=?', args})).rows[0]
        const receiptResult = (receipt: Row): Result => {
            if (receipt.digest !== digest) throw new Error('Tool call identity was reused')
            if (receipt.state !== 'saved' && receipt.state !== 'unchanged') return unknown(path)
            try {
                const parsed = resultSchema.safeParse(JSON.parse(String(receipt.result)))
                return parsed.success && parsed.data.path === path && parsed.data.status === receipt.state ? parsed.data : unknown(path)
            } catch { return unknown(path) }
        }
        const observe = async (work: Promise<Result>) => {
            try { const result = await abortable(work, signal); await guard(); return result }
            catch (error) { if (signal.aborted) return unknown(path); throw error }
        }
        const existing = pending.get(key)
        if (existing) {
            if (existing.digest !== digest) throw new Error('Tool call identity was reused')
            return observe(existing.result)
        }
        const work = async (): Promise<Result> => {
            const receipt = await readReceipt()
            await guard()
            if (receipt) return receiptResult(receipt)
            let content: string, snapshot: PrivateFileSnapshot | undefined, occurrences = 0, unchanged = false
            if ('content' in call.arguments) content = boundedPrivateText(call.arguments.content)
            else {
                snapshot = await readPrivateCoworkerFile(authority.runtime, authority.owner, path, guard)
                await guard()
                if (snapshot.truncated || !snapshot.hash || !snapshot.identity) throw new Error('Complete editable document and file identity required')
                const edited = editPrivateText(snapshot.content, call.arguments.oldString, call.arguments.newString, call.arguments.replaceAll)
                content = edited.content; occurrences = edited.occurrences; unchanged = content === snapshot.content
            }
            await guard()
            const claim = await db.execute({sql: 'INSERT INTO desktop_private_file_calls(owner,run_id,call_id,digest,state) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING',
                args: [...args, digest, 'claimed']})
            if (claim.rowsAffected !== 1) {
                const winner = await readReceipt()
                await guard()
                return winner ? receiptResult(winner) : unknown(path)
            }
            try {
                await guard()
                if (!unchanged) {
                    const publication = {beforePublish: guard, existingDirectoryOnly: true as const, snapshot}
                    if (snapshot) await saveCoworkerFile(authority.runtime, authority.owner, path, content, snapshot.hash, snapshot.identity, publication)
                    else {
                        const slash = path.lastIndexOf('/')
                        await importCoworkerFile(authority.runtime, authority.owner, slash < 0 ? '' : path.slice(0, slash), path.slice(slash + 1), Buffer.from(content), publication)
                    }
                }
                const result: Result = unchanged
                    ? {status: 'unchanged', path, message: 'oldString and newString are identical; nothing to do.'}
                    : {status: 'saved', path, message: snapshot
                        ? `Edited ${path} (${occurrences} replacement${occurrences === 1 ? '' : 's'})`
                        : `Wrote ${Buffer.byteLength(content)} bytes to ${path}`}
                // Record a completed publication even if Stop arrived just afterwards. The caller
                // observes its own deadline; an uncertain durable claim is never discarded.
                const recorded = await db.execute({sql: 'UPDATE desktop_private_file_calls SET state=?,result=? WHERE owner=? AND run_id=? AND call_id=? AND digest=?',
                    args: [result.status, JSON.stringify(result), ...args, digest]})
                return recorded.rowsAffected === 1 ? result : unknown(path)
            } catch { return unknown(path) }
        }
        const result = Promise.resolve().then(work)
        pending.set(key, {digest, result})
        const settled = () => { if (pending.get(key)?.result === result) pending.delete(key) }
        // Only the actual operation releases this slot. A timed-out observer must not admit a
        // competing retry while a filesystem or SQLite operation is still resolving.
        void result.then(settled, settled)
        return observe(result)
    }
}
