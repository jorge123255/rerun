import { createHash } from 'node:crypto'
import type { Client, Transaction } from '@libsql/client'
import { z } from 'zod'
import { DesktopHttpError } from '../auth'
const id = z.string().min(1).max(256)
export const alternateInputSchema = z.strictObject({ workspaceId: id, chatId: id, requestId: z.uuid(), messageId: z.string().regex(/^engine-[A-Za-z0-9_-]{1,128}$/), transcriptRevision: id })
export type AlternateInput = z.infer<typeof alternateInputSchema>
export type AlternateProof = { workspaceId: string; chatId: string; sourceSessionId: string; messageId: string; sourceRunId: string; transcriptRevision: string; textDigest: string; precedingUserId: string; activeTurn: boolean; activeBuild: boolean; pendingDecision: boolean; completed: boolean }
export type AlternateTarget = { sessionId: string; runId: string; requestId: string; sourceSessionId: string; sourceRunId: string; messageId: string; transcriptRevision: string }
export type AlternateReceipt = { input: AlternateInput; proof: AlternateProof; state: 'reserved' | 'uncertain' | 'ready'; alternate: AlternateTarget | null; runIntent?: 'start' | 'stop' }
export const FOREMAN_ALTERNATE_SQL = `CREATE TABLE IF NOT EXISTS desktop_foreman_alternates(request_id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,chat_id TEXT NOT NULL,fingerprint TEXT NOT NULL,body TEXT NOT NULL);`
export type AlternateAuthority = {
    access(tx: Transaction, scope: { workspaceId: string; chatId: string }): Promise<void>
    /** Prove exact raw engine reply/run/preceding turn in owned saved history, under the shared
     * Foreman turn lock. Public transformed UIMessage IDs alone cannot satisfy this port. */
    target(tx: Transaction, input: AlternateInput): Promise<AlternateProof | null>
}
export type AlternateEngine = {
    /** Must recheck current ownership/grant/target and all blockers at the engine effect boundary,
     * atomically persist fork + stable request receipt, and register alternate ownership
     * before any run can act. Stop may address only this returned run/session. */
    fork(input: AlternateInput, proof: AlternateProof): Promise<AlternateTarget>
    /** Passive exact request lookup; never dispatch/retry on missing or uncertain result. */
    lookup(input: AlternateInput, proof: AlternateProof): Promise<AlternateTarget | null>
}
const refusal = () => new DesktopHttpError(409, 'This saved Foreman reply cannot be forked safely. Reopen its original conversation.')
export function createForemanAlternateRepository(db: Client, authority: AlternateAuthority, engine?: AlternateEngine) {
    async function write<T>(work: (tx: Transaction) => Promise<T>) {
        const tx = await db.transaction('write')
        try { const value = await work(tx); await tx.commit(); return value } catch (error) { await tx.rollback(); throw error } finally { tx.close() }
    }
    async function owned(tx: Transaction, input: AlternateInput) {
        await authority.access(tx, { workspaceId: input.workspaceId, chatId: input.chatId })
        const row = (await tx.execute({ sql: 'SELECT * FROM desktop_foreman_alternates WHERE request_id=?', args: [input.requestId] })).rows[0]
        const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex')
        if (row && (row.workspace_id !== input.workspaceId || row.chat_id !== input.chatId || row.fingerprint !== fingerprint)) throw refusal()
        return { row, fingerprint }
    }
    return {
        async request(raw: AlternateInput): Promise<AlternateReceipt> {
            const input = alternateInputSchema.parse(raw)
            const reservation = await write(async tx => {
                const { row, fingerprint } = await owned(tx, input)
                if (row) return { receipt: JSON.parse(String(row.body)) as AlternateReceipt, fresh: false }
                if (!engine) throw refusal()
                const proof = await authority.target(tx, input)
                if (!proof || proof.workspaceId !== input.workspaceId || proof.chatId !== input.chatId || proof.messageId !== input.messageId || proof.transcriptRevision !== input.transcriptRevision || !proof.sourceSessionId || !proof.sourceRunId || !proof.textDigest || !proof.precedingUserId || !proof.completed || proof.activeTurn || proof.activeBuild || proof.pendingDecision) throw refusal()
                const receipt: AlternateReceipt = { input, proof, state: 'reserved', alternate: null }
                await tx.execute({ sql: 'INSERT INTO desktop_foreman_alternates VALUES(?,?,?,?,?)', args: [input.requestId, input.workspaceId, input.chatId, fingerprint, JSON.stringify(receipt)] })
                return { receipt, fresh: true }
            })
            if (reservation.receipt.state === 'ready') return reservation.receipt
            let alternate: AlternateTarget | null = null
            try {
                alternate = reservation.fresh ? await engine!.fork(input, reservation.receipt.proof) : await engine?.lookup(input, reservation.receipt.proof) ?? null
                if (alternate && (!id.safeParse(alternate.sessionId).success || !id.safeParse(alternate.runId).success || alternate.sessionId === reservation.receipt.proof.sourceSessionId || alternate.runId === reservation.receipt.proof.sourceRunId || alternate.requestId !== input.requestId || alternate.sourceSessionId !== reservation.receipt.proof.sourceSessionId || alternate.sourceRunId !== reservation.receipt.proof.sourceRunId || alternate.messageId !== input.messageId || alternate.transcriptRevision !== input.transcriptRevision)) alternate = null
            } catch { /* Uncertain effect: a later explicit request may only look up its receipt. */ }
            return write(async tx => {
                const { row } = await owned(tx, input)
                if (!row) throw refusal()
                const saved = JSON.parse(String(row.body)) as AlternateReceipt
                if (saved.state === 'ready') return saved
                const next: AlternateReceipt = { ...saved, state: alternate ? 'ready' : 'uncertain', alternate }
                await tx.execute({ sql: 'UPDATE desktop_foreman_alternates SET body=? WHERE request_id=?', args: [JSON.stringify(next), input.requestId] })
                return next
            })
        },
    }
}
