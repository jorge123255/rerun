import { describe, expect, it, vi } from 'vitest'
import type { DesktopClaudePlanAttempt, DesktopClaudePlanCredential } from '@rerun/contracts'
import { createDesktopClaudePlanAuth } from './auth'

const oauthStart = { authorizeUrl: 'https://claude.ai/oauth/authorize?code=true', verifier: 'verifier', state: 'state' }
const credential: DesktopClaudePlanCredential = { accessToken: 'access', refreshToken: 'refresh', expiresAt: 1_000 }

function fixture() {
    const credentials = new Map<string, DesktopClaudePlanCredential>()
    const attempts = new Map<string, DesktopClaudePlanAttempt>()
    const oauth = {
        start: vi.fn(async () => oauthStart),
        exchange: vi.fn(async () => credential),
    }
    const custody = {
        load: vi.fn(async (agentId: string) => credentials.get(agentId) ?? null),
        save: vi.fn(async (agentId: string, value: DesktopClaudePlanCredential) => {
            credentials.set(agentId, value)
            return { revision: '1' }
        }),
        clear: vi.fn(async (agentId: string) => { credentials.delete(agentId) }),
    }
    const outcomes = {
        begin: vi.fn(async (attempt: DesktopClaudePlanAttempt) => attempts.get(attempt.attemptId) ?? 'execute' as const),
        complete: vi.fn(async (attempt: DesktopClaudePlanAttempt) => { attempts.set(attempt.attemptId, attempt) }),
        read: vi.fn(async (attemptId: string) => attempts.get(attemptId) ?? null),
        active: vi.fn(async () => [...attempts.values()].at(-1) ?? null),
        connected: vi.fn(async () => [...attempts.values()].find(attempt => attempt.phase === 'connected') ?? null),
    }
    return { oauth, custody, outcomes, credentials, attempts }
}

describe('desktop Claude plan auth', () => {
    it('coalesces one active owner attempt and completes into isolated custody', async () => {
        const parts = fixture()
        const auth = createDesktopClaudePlanAuth(parts, { now: () => '2026-11-05T10:00:00.000Z' })
        const first = await auth.start('agent')
        const second = await auth.start('agent')
        expect(second).toEqual(first)
        expect(parts.oauth.start).toHaveBeenCalledTimes(1)
        const connected = await auth.complete({ attemptId: first.attemptId, requestId: crypto.randomUUID(), rawCode: 'code#state', verifier: 'verifier', state: 'state' })
        expect(connected.phase).toBe('connected')
        expect(parts.credentials.get('agent')).toEqual(credential)
        expect(JSON.stringify(connected)).not.toContain('code#state')
    })

    it('preserves an existing successful credential after a failed replacement', async () => {
        const parts = fixture()
        parts.credentials.set('agent', credential)
        parts.oauth.exchange = vi.fn(async () => { throw new Error('Exchange failed') })
        const auth = createDesktopClaudePlanAuth(parts, { now: () => '2026-11-05T10:00:00.000Z' })
        const attempt = await auth.start('agent')
        await expect(auth.complete({ attemptId: attempt.attemptId, requestId: crypto.randomUUID(), rawCode: 'bad', verifier: 'verifier', state: 'state' })).resolves.toMatchObject({ phase: 'error' })
        expect(parts.credentials.get('agent')).toEqual(credential)
        const replacement = await auth.start('agent')
        expect(replacement.attemptId).not.toBe(attempt.attemptId)
        expect(parts.oauth.start).toHaveBeenCalledTimes(2)
    })

    it('cancels without clearing custody and disconnects only the connected attempt', async () => {
        const parts = fixture()
        const auth = createDesktopClaudePlanAuth(parts, { now: () => '2026-11-05T10:00:00.000Z' })
        const attempt = await auth.start('agent')
        const connected = await auth.complete({ attemptId: attempt.attemptId, requestId: crypto.randomUUID(), rawCode: 'code', verifier: 'verifier', state: 'state' })
        const cancelled = await auth.cancel({ operation: 'cancel', requestId: crypto.randomUUID(), attemptId: attempt.attemptId, expectedRevision: connected.revision })
        expect(cancelled.phase).toBe('cancelled')
        expect(parts.custody.clear).not.toHaveBeenCalled()
        const disconnected = await auth.disconnect({ operation: 'disconnect', requestId: crypto.randomUUID(), attemptId: connected.attemptId, expectedRevision: connected.revision })
        expect(disconnected.phase).toBe('disconnected')
        expect(parts.custody.clear).toHaveBeenCalledWith('agent')
    })

    it('expires a waiting attempt on status without exchanging again', async () => {
        const parts = fixture()
        const auth = createDesktopClaudePlanAuth(parts, { now: () => '2026-11-05T10:16:00.000Z' })
        const attempt = await auth.start('agent')
        const current = await auth.status(attempt.attemptId)
        expect(current?.phase).toBe('expired')
        expect(parts.oauth.exchange).not.toHaveBeenCalled()
    })
})
