import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopToolInstallSnapshot } from '@rerun/contracts'
import { createDesktopToolInstallClient, DesktopToolInstallClientError } from './tool-install-client'

const snapshot: DesktopToolInstallSnapshot = {
    operationId: 'a'.repeat(64), agentId: 'agent', sessionId: 'session', runId: 'run', toolCallId: 'tool', proposalRevision: '1', revision: '1', status: 'pending-approval',
    packages: [{ package: 'left-pad@1.2.3', status: 'pending' }], guestId: 'b'.repeat(64), availability: 'isolated-guest-only', createdAt: '2026-11-05T10:00:00.000Z', updatedAt: '2026-11-05T10:00:00.000Z',
}
const installed: DesktopToolInstallSnapshot = {
    ...snapshot, revision: '4', status: 'installed', updatedAt: '2026-11-05T10:01:00.000Z',
    packages: [{ package: 'left-pad@1.2.3', status: 'installed', manifestSha256: 'a'.repeat(64), lockSha256: 'b'.repeat(64) }],
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('desktop tool install client', () => {
    it('rejects a read response owned by another conversation', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({ installation: { ...snapshot, sessionId: 'other' } })))
        const client = createDesktopToolInstallClient('session')
        await expect(client.read(snapshot.operationId)).rejects.toThrow('another conversation')
        client.dispose()
    })

    it('reuses the exact decision UUID after an unknown acknowledgement', async () => {
        const sent: Record<string, unknown>[] = []
        const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
            sent.push(JSON.parse(String(init.body)))
            if (sent.length === 1) return Response.json({ error: 'ack unavailable' }, { status: 503 })
            return Response.json({ installation: installed })
        })
        vi.stubGlobal('fetch', fetcher)
        const client = createDesktopToolInstallClient('session')
        await expect(client.decide(snapshot, 'approved')).rejects.toThrow('ack unavailable')
        await expect(client.decide(snapshot, 'approved')).resolves.toEqual(installed)
        expect(sent[0]).toEqual(sent[1])
        expect(sent[0]).toMatchObject({ operation: 'decide', operationId: snapshot.operationId, expectedRevision: '1', decision: 'approved' })
        client.dispose()
    })

    it('returns the authoritative snapshot from a revision race', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'Installation changed.', installation: installed }, { status: 409 })))
        const client = createDesktopToolInstallClient('session')
        const failure = await client.decide(snapshot, 'approved').catch(error => error)
        expect(failure).toBeInstanceOf(DesktopToolInstallClientError)
        expect(failure.snapshot).toEqual(installed)
        client.dispose()
    })

    it('uses inspect only for recovery and refuses new work after disposal', async () => {
        const sent: Record<string, unknown>[] = []
        const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
            sent.push(JSON.parse(String(init.body)))
            return Response.json({ installation: installed })
        })
        vi.stubGlobal('fetch', fetcher)
        const client = createDesktopToolInstallClient('session')
        await client.inspect(snapshot)
        client.dispose()
        await expect(client.decide(snapshot, 'approved')).rejects.toThrow('owner changed')
        expect(sent).toHaveLength(1)
        expect(sent[0]).toMatchObject({ operation: 'inspect', operationId: snapshot.operationId, expectedRevision: '1' })
        expect(fetcher).toHaveBeenCalledTimes(1)
    })

    it('fails closed on malformed responses', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({ installation: { operationId: 'bad' } })))
        const client = createDesktopToolInstallClient('session')
        await expect(client.read(snapshot.operationId)).rejects.toThrow()
        client.dispose()
    })
})
