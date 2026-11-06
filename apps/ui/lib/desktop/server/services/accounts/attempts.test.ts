import { createClient } from '@libsql/client'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import type { DesktopServiceAccountMutation } from '@rerun/contracts'
import { serviceStore } from '../store'
import { ensureDesktopServiceAccountSchema } from './schema'
import { canonical } from './installs'
import { sqliteReservations } from './reservations'
import { accountAttempts } from './attempts'

const databases: ReturnType<typeof createClient>[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })
const input = (): DesktopServiceAccountMutation => ({ action: 'install', requestId: crypto.randomUUID(), intent: { kind: 'additional', slug: 'fixture' }, authMethodId: 'token', values: { TOKEN: 'do-not-store-this-private-value' } })
async function setup() {
    const db = createClient({ url: 'file::memory:' }); databases.push(db)
    await ensureDesktopServiceAccountSchema(db)
    const store = serviceStore(db, () => Buffer.alloc(32, 7)), attempts = accountAttempts(store)
    return { db, store, attempts, async complete(owner: string, mutation: DesktopServiceAccountMutation) {
        const reservations = sqliteReservations(db)
        const row = await reservations.begin(owner, mutation.requestId, store.digest(owner, canonical(mutation)), new Date().toISOString())
        await reservations.save({ ...row, phase: 'complete', publicResult: { status: 'needs_config', accountKey: 'fixture@aaaaaa' } }, row.phase)
    } }
}
it('recovers the same request across process/origin restart and keeps plaintext out of the journal', async () => {
    const h = await setup(), first = input()
    expect(await h.attempts('owner', { action: 'prepare-attempt', mutation: first })).toEqual({ requestId: first.requestId })
    const restarted = accountAttempts(h.store)
    expect(await restarted('owner', { action: 'prepare-attempt', mutation: { ...first, requestId: crypto.randomUUID() } })).toEqual({ requestId: first.requestId })
    const rows = (await h.db.execute('SELECT * FROM desktop_service_account_attempts')).rows
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows)).not.toContain('do-not-store-this-private-value')
    expect(JSON.stringify(rows)).not.toContain('additional')
})
it('requires the exact owner, request, body and complete receipt before acknowledging', async () => {
    const h = await setup(), first = input()
    await h.attempts('owner', { action: 'prepare-attempt', mutation: first })
    await expect(h.attempts('owner', { action: 'acknowledge-attempt', mutation: first })).rejects.toThrow('not complete')
    await h.complete('owner', first)
    await expect(h.attempts('other', { action: 'acknowledge-attempt', mutation: first })).rejects.toThrow('not complete')
    await expect(h.attempts('owner', { action: 'acknowledge-attempt', mutation: { ...first, values: { TOKEN: 'changed' } } })).rejects.toThrow('not complete')
    expect(await h.attempts('owner', { action: 'acknowledge-attempt', mutation: first })).toEqual({ acknowledged: true, requestId: first.requestId })
})
it('retains a lost acknowledgement and rotates once only for a later explicitly acknowledged action', async () => {
    const h = await setup(), first = input()
    await h.attempts('owner', { action: 'prepare-attempt', mutation: first }); await h.complete('owner', first)
    await h.attempts('owner', { action: 'acknowledge-attempt', mutation: first })
    const next = { ...first, requestId: crypto.randomUUID() }
    // No renderer storage survives this restart. Recover the acknowledged receipt first.
    expect(await accountAttempts(h.store)('owner', { action: 'prepare-attempt', mutation: next })).toEqual({ requestId: first.requestId })
    expect(await h.attempts('owner', { action: 'prepare-attempt', mutation: next, afterRequestId: first.requestId })).toEqual({ requestId: next.requestId })
    expect(await h.attempts('owner', { action: 'prepare-attempt', mutation: { ...first, requestId: crypto.randomUUID() }, afterRequestId: first.requestId })).toEqual({ requestId: next.requestId })
    expect(await h.attempts('other', { action: 'prepare-attempt', mutation: first })).toEqual({ requestId: first.requestId })
})

it('does not turn an interrupted probe into a completed or silently repeated attempt', async () => {
    const h = await setup()
    const mutation: DesktopServiceAccountMutation = { action: 'probe', requestId: crypto.randomUUID(), intent: { kind: 'existing', accountKey: 'fixture', expectedRevision: crypto.randomUUID() } }
    await h.attempts('owner', { action: 'prepare-attempt', mutation })
    const reservations = sqliteReservations(h.db)
    const row = await reservations.begin('owner', mutation.requestId, h.store.digest('owner', canonical(mutation)), new Date().toISOString())
    await reservations.save({ ...row, phase: 'probing' }, 'reserved')
    await expect(h.attempts('owner', { action: 'acknowledge-attempt', mutation })).rejects.toThrow('not complete')
    expect(await accountAttempts(h.store)('owner', { action: 'prepare-attempt', mutation: { ...mutation, requestId: crypto.randomUUID() }, afterRequestId: mutation.requestId })).toEqual({ requestId: mutation.requestId })
})
