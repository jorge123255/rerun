import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@libsql/client'
import { expect, it } from 'vitest'
import { desktopGuestShellStore } from './store.js'
import { DESKTOP_GUEST_SHELL_SCHEMA_SQL } from './schema.js'
import type { DesktopGuestShellRequest, DesktopGuestShellReceipt } from './types.js'
const request: DesktopGuestShellRequest = { agentId: 'agent', sessionId: 'session', runId: 'run', toolCallId: 'call', requestId: '11111111-1111-4111-8111-111111111111', guest: { engineAgentId: 'agent', launchNonce: 'launch', sessionGeneration: 'a'.repeat(32), workspaceFingerprint: 'b'.repeat(64) }, fingerprint: 'c'.repeat(64), command: 'printf private-input', timeoutMs: 120000, cwd: '' }
const identity = { agentId: request.agentId, sessionId: request.sessionId, runId: request.runId, toolCallId: request.toolCallId, requestId: request.requestId, guest: request.guest }
const initial: DesktopGuestShellReceipt = { requestId: request.requestId, identity, fingerprint: request.fingerprint, status: 'interrupted', stdout: '', stderr: '', durationMs: 0, exitCode: null }
it('host receipts reserve once, survive service recreation, and never overwrite a final result', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rerun-shell-ledger-'))
    const db = createClient({ url: `file:${join(directory, 'receipts.db')}` })
    try {
        await db.executeMultiple(DESKTOP_GUEST_SHELL_SCHEMA_SQL)
        const store = desktopGuestShellStore(db)
        const [a, b] = await Promise.all([store.begin(request, initial), store.begin(request, initial)])
        expect([a,b].filter(value => value === 'execute')).toHaveLength(1)
        const saved = (await db.execute('SELECT * FROM desktop_guest_shell_requests')).rows[0]
        expect(JSON.stringify(saved)).not.toContain('private-input')
        const done = { ...initial, status: 'done' as const, stdout: 'ok', exitCode: 0 }
        await store.complete(identity, done)
        expect(await desktopGuestShellStore(db).read(request.requestId)).toEqual(done)
        await expect(store.complete(identity, { ...initial, status: 'cancelled' })).rejects.toThrow('final result')
        await expect(store.begin({ ...request, sessionId: 'other' }, { ...initial, identity: { ...identity, sessionId: 'other' } })).rejects.toThrow('conflict')
    } finally { db.close(); await rm(directory, { recursive: true, force: true }) }
})
