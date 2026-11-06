import 'server-only'
import { z } from 'zod'
import { desktopServiceAccountMutationSchema } from '@rerun/contracts'
import type { ServiceStore } from '../store'
import { canonical } from './installs'

export const accountAttemptRequest = z.discriminatedUnion('action', [
    z.object({ action: z.literal('prepare-attempt'), mutation: desktopServiceAccountMutationSchema, afterRequestId: z.uuid().optional() }).strict(),
    z.object({ action: z.literal('acknowledge-attempt'), mutation: desktopServiceAccountMutationSchema }).strict(),
])

/** Only owner-bound HMACs and request IDs persist here, never submitted values. */
export function accountAttempts(store: ServiceStore) {
    return async (owner: string, raw: unknown) => {
        const input = accountAttemptRequest.parse(raw)
        const { requestId: proposed, ...payload } = input.mutation
        const fingerprint = store.digest(owner, canonical(['account-attempt-v1', payload]))
        if (input.action === 'prepare-attempt') {
            await store.db.execute({
                sql: `INSERT INTO desktop_service_account_attempts(owner,fingerprint,request_id)
                    SELECT ?,?,? WHERE (SELECT COUNT(*) FROM desktop_service_account_attempts WHERE owner=?)<4096
                    ON CONFLICT(owner,fingerprint) DO NOTHING`, args: [owner, fingerprint, proposed, owner],
            })
            if (input.afterRequestId && input.afterRequestId !== proposed) {
                // A new user action can rotate only the exact acknowledged attempt.
                // Lost acknowledgements therefore replay safely after an app restart.
                await store.db.execute({ sql: 'UPDATE desktop_service_account_attempts SET request_id=?,acknowledged=0 WHERE owner=? AND fingerprint=? AND request_id=? AND acknowledged=1', args: [proposed, owner, fingerprint, input.afterRequestId] })
            }
            const row = (await store.db.execute({ sql: 'SELECT request_id FROM desktop_service_account_attempts WHERE owner=? AND fingerprint=?', args: [owner, fingerprint] })).rows[0]
            if (!row) throw new Error('Account attempt unavailable')
            return { requestId: z.uuid().parse(String(row.request_id)) }
        }
        const receipt = (await store.db.execute({ sql: 'SELECT fingerprint,phase FROM desktop_service_account_mutations WHERE owner=? AND request_id=?', args: [owner, proposed] })).rows[0]
        if (!receipt || receipt.phase !== 'complete' || receipt.fingerprint !== store.digest(owner, canonical(input.mutation))) throw new Error('Account attempt is not complete')
        const ack = await store.db.execute({ sql: 'UPDATE desktop_service_account_attempts SET acknowledged=1 WHERE owner=? AND fingerprint=? AND request_id=?', args: [owner, fingerprint, proposed] })
        if (ack.rowsAffected !== 1) throw new Error('Account attempt changed')
        return { acknowledged: true as const, requestId: proposed }
    }
}
