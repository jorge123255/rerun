import { createHash } from 'node:crypto'
import type { Client, Transaction } from '@libsql/client'
import { z } from 'zod'
import { DesktopHttpError } from '../auth'
import { starterChoiceSchema } from '../../foreman-client/starter'
export { starterChoiceSchema } from '../../foreman-client/starter'

const id = z.string().trim().min(1).max(256)
export const starterScopeSchema = z.strictObject({ workspaceId: id, chatId: id })
export const starterBindingSchema = starterScopeSchema.extend({ sessionId: id, runId: id, turnRevision: id, messageId: id, toolCallId: id, grantRevision: id, widgetDigest: id })
export type StarterBinding = z.infer<typeof starterBindingSchema>
export const starterDecisionSchema = starterScopeSchema.extend({ requestId: id, revision: z.literal('1'), choice: starterChoiceSchema })
export type StarterDecision = z.infer<typeof starterDecisionSchema>
export type StarterPending = StarterBinding & { requestId: string; revision: '1'; offered: string[] }
export type StarterDecisionReceipt = { receiptId: string; request: StarterPending; choice: StarterDecision['choice']; output: { answered: false } | { answered: true; custom: string } | { answered: true; chosen: string[] }; continuationRequestId: string | null }
export const FOREMAN_STARTER_SQL = `
CREATE TABLE IF NOT EXISTS desktop_foreman_starter_requests(request_id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,chat_id TEXT NOT NULL,binding TEXT NOT NULL,body TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','consumed','superseded')),UNIQUE(chat_id,binding));
CREATE UNIQUE INDEX IF NOT EXISTS desktop_foreman_starter_pending ON desktop_foreman_starter_requests(workspace_id,chat_id) WHERE state='pending';
CREATE TABLE IF NOT EXISTS desktop_foreman_starter_receipts(request_id TEXT PRIMARY KEY REFERENCES desktop_foreman_starter_requests(request_id),fingerprint TEXT NOT NULL,body TEXT NOT NULL);
`
export type StarterAuthority = {
    /** Authenticate current workspace/chat ownership and current grant, even for receipt recovery. */
    access(tx: Transaction, scope: { workspaceId: string; chatId: string }): Promise<void>
    /** Read canonical saved widget + matching current turn/grant inside this transaction/turn lock.
     * Refuse stopped, superseded, ordinary-chat and welcome requests. Never trust renderer parts. */
    pending(tx: Transaction, binding: StarterBinding): Promise<{ offered: string[] } | null>
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const bindingOf = (request: StarterPending) => starterBindingSchema.parse(Object.fromEntries(Object.keys(starterBindingSchema.shape).map(key => [key, request[key as keyof StarterPending]])))
const conflict = () => new DesktopHttpError(409, 'This starter decision changed. Reopen its saved request.')
export function createForemanStarterRepository(db: Client, authority: StarterAuthority) {
    async function write<T>(work: (tx: Transaction) => Promise<T>) {
        const tx = await db.transaction('write')
        try { const result = await work(tx); await tx.commit(); return result } catch (error) { await tx.rollback(); throw error } finally { tx.close() }
    }
    const read = async (tx: Transaction, requestId: string) => (await tx.execute({ sql: 'SELECT * FROM desktop_foreman_starter_requests WHERE request_id=?', args: [requestId] })).rows[0]
    return {
        /** Server observation only. Do not expose publication as a renderer POST. */
        publish(raw: StarterBinding) {
            const binding = starterBindingSchema.parse(raw)
            return write(async tx => {
                await authority.access(tx, { workspaceId: binding.workspaceId, chatId: binding.chatId })
                const proof = await authority.pending(tx, binding)
                if (!proof || new Set(proof.offered).size !== proof.offered.length || proof.offered.length > 128 || proof.offered.some(value => !id.safeParse(value).success)) throw conflict()
                const requestId = `fsr_${hash(binding)}`
                const previous = await read(tx, requestId)
                if (previous) {
                    if (previous.state !== 'pending') throw conflict()
                    const saved = JSON.parse(String(previous.body)) as StarterPending
                    if (hash(saved.offered) !== hash(proof.offered)) throw conflict()
                    return saved
                }
                const request: StarterPending = { ...binding, requestId, revision: '1', offered: [...proof.offered] }
                await tx.execute({ sql: "UPDATE desktop_foreman_starter_requests SET state='superseded' WHERE workspace_id=? AND chat_id=? AND state='pending'", args: [binding.workspaceId, binding.chatId] })
                await tx.execute({ sql: "INSERT INTO desktop_foreman_starter_requests VALUES(?,?,?,?,?,'pending')", args: [requestId, binding.workspaceId, binding.chatId, JSON.stringify(binding), JSON.stringify(request)] })
                return request
            })
        },
        decide(raw: StarterDecision) {
            const input = starterDecisionSchema.parse(raw)
            if (input.choice.kind === 'cards') {
                if (new Set(input.choice.chosen).size !== input.choice.chosen.length) throw conflict()
                input.choice.chosen.sort()
            }
            const fingerprint = hash(input)
            return write(async tx => {
                await authority.access(tx, { workspaceId: input.workspaceId, chatId: input.chatId })
                const row = await read(tx, input.requestId)
                if (!row || row.workspace_id !== input.workspaceId || row.chat_id !== input.chatId) throw conflict()
                const old = (await tx.execute({ sql: 'SELECT * FROM desktop_foreman_starter_receipts WHERE request_id=?', args: [input.requestId] })).rows[0]
                if (old) { if (old.fingerprint !== fingerprint) throw conflict(); return JSON.parse(String(old.body)) as StarterDecisionReceipt }
                if (row.state !== 'pending') throw conflict()
                const request = JSON.parse(String(row.body)) as StarterPending
                const proof = await authority.pending(tx, bindingOf(request))
                if (!proof || hash(proof.offered) !== hash(request.offered)) throw conflict()
                if (input.choice.kind === 'cards' && input.choice.chosen.some(value => !request.offered.includes(value))) throw conflict()
                const output = input.choice.kind === 'dismiss' ? { answered: false as const } : input.choice.kind === 'text' ? { answered: true as const, custom: input.choice.text } : { answered: true as const, chosen: [...input.choice.chosen] }
                const receipt: StarterDecisionReceipt = { receiptId: `fsd_${fingerprint}`, request, choice: input.choice, output, continuationRequestId: input.choice.kind === 'dismiss' ? null : `fsc_${fingerprint}` }
                const updated = await tx.execute({ sql: "UPDATE desktop_foreman_starter_requests SET state='consumed' WHERE request_id=? AND state='pending'", args: [input.requestId] })
                if (updated.rowsAffected !== 1) throw conflict()
                await tx.execute({ sql: 'INSERT INTO desktop_foreman_starter_receipts VALUES(?,?,?)', args: [input.requestId, fingerprint, JSON.stringify(receipt)] })
                return receipt
            })
        },
        pending(scope: { workspaceId: string; chatId: string }) {
            const parsed = starterScopeSchema.parse(scope)
            return write(async tx => {
                await authority.access(tx, parsed)
                const row = (await tx.execute({ sql: "SELECT body FROM desktop_foreman_starter_requests WHERE workspace_id=? AND chat_id=? AND state='pending'", args: [parsed.workspaceId, parsed.chatId] })).rows[0]
                if (!row) return null
                const request = JSON.parse(String(row.body)) as StarterPending
                const proof = await authority.pending(tx, bindingOf(request))
                return proof && hash(proof.offered) === hash(request.offered) ? request : null
            })
        },
        receipt(scope: { workspaceId: string; chatId: string }, requestId: string) {
            const parsed = starterScopeSchema.parse(scope); id.parse(requestId)
            return write(async tx => {
                await authority.access(tx, parsed)
                const row = await read(tx, requestId)
                if (!row || row.workspace_id !== parsed.workspaceId || row.chat_id !== parsed.chatId) return null
                const saved = (await tx.execute({ sql: 'SELECT body FROM desktop_foreman_starter_receipts WHERE request_id=?', args: [requestId] })).rows[0]
                return saved ? JSON.parse(String(saved.body)) as StarterDecisionReceipt : null
            })
        },
    }
}
