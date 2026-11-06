import { describe, expect, it } from 'vitest'
import { createClient } from '@libsql/client'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DesktopCompanyProfileAttempt } from '@rerun/contracts'
import { ensureDesktopCompanyProfileSchema } from './schema'
import { createSqliteDesktopCompanyProfileStore } from './store'

const attempt: DesktopCompanyProfileAttempt = {
    contractVersion: 1, requestId: randomUUID(), kind: 'decide',
    identity: { chat: { workspaceId: 'ws-1', chatId: 'fmc_sqlite01' }, draftRevision: 2, inputDigest: 'c'.repeat(64) },
    status: 'pending', progress: { stage: 'queued', sources: [], updatedAt: '2026-11-06T00:00:00.000Z' }, outcome: null, evidence: [], modelCalled: false,
    createdAt: '2026-11-06T00:00:00.000Z', updatedAt: '2026-11-06T00:00:00.000Z',
}

describe('SQLite company profile derived attempt store', () => {
    it('reopens the exact saved success and refuses late settlement after cancellation', async () => {
        const root = await mkdtemp(join(tmpdir(), 'rerun-company-profile-'))
        const file = join(root, 'desktop.db')
        const first = createClient({ url: `file:${file}` })
        try {
            await ensureDesktopCompanyProfileSchema(first)
            const store = createSqliteDesktopCompanyProfileStore(first, { schemaReady: true })
            await store.insert(attempt)
            const cancelled = { ...attempt, status: 'cancelled' as const, outcome: { status: 'cancelled' as const, message: 'Stopped.', decision: null, profile: null }, progress: { ...attempt.progress, stage: 'settled' as const } }
            expect(await store.settle(cancelled)).toBe(true)
            expect(await store.settle({ ...attempt, status: 'succeeded' as const, outcome: { status: 'succeeded', decision: { industry: 'saas', confidence: 0.9, source: 'inference' }, profile: null } })).toBe(false)
        } finally { first.close() }
        const second = createClient({ url: `file:${file}` })
        try {
            const reopened = createSqliteDesktopCompanyProfileStore(second, { schemaReady: true })
            expect((await reopened.get(attempt.requestId))?.attempt.status).toBe('cancelled')
            expect((await reopened.latest(attempt.identity.chat, 'decide'))?.requestId).toBe(attempt.requestId)
        } finally { second.close(); await rm(root, { recursive: true, force: true }) }
    })
})
