'use client'

import { desktopClaudePlanSnapshotSchema, type ConnectionsList, type DesktopClaudePlanAction, type DesktopClaudePlanSnapshot } from '@rerun/contracts'
import type { DesktopClaudePlanRuntime } from './use-desktop-claude-plan'

/** Only the public attempt identity survives a renderer reload. Codes and tokens never do. */
const JOURNAL = 'rerun:claude-login:pending:v1'
// The encrypted engine state remains authoritative when browser storage is disabled.
// A lost response is reconciled by GET; a missing browser journal never replays POST.
function journal(value?: string | null): string | null {
    try {
        const storage = window.localStorage
        if (!storage) return null
        if (value === null) storage.removeItem(JOURNAL)
        else if (value !== undefined) storage.setItem(JOURNAL, value)
        return storage.getItem(JOURNAL)
    } catch { return null }
}
type Receipt = { requestId: string; operation: DesktopClaudePlanAction['operation']; attemptId: string | null; expectedRevision: string }
export function createDesktopClaudePlanClient(onProviders: (providers: ConnectionsList) => void): DesktopClaudePlanRuntime {
    let current: DesktopClaudePlanSnapshot | null = null
    function accept(snapshot: DesktopClaudePlanSnapshot, providers: ConnectionsList) {
        if (!current || BigInt(snapshot.revision) >= BigInt(current.revision)) { current = snapshot; onProviders(providers) }
        return current
    }
    async function read(signal: AbortSignal) {
        const response = await fetch('/api/desktop/claude-login', { cache: 'no-store', signal })
        if (!response.ok) throw new Error('Could not read Claude sign-in. Try checking its saved state again.')
        const value = await response.json(), snapshot = desktopClaudePlanSnapshotSchema.parse(value.status)
        signal.throwIfAborted()
        const accepted = accept(snapshot, value.providers)
        // A passive read can acknowledge a saved attempt. It never resumes an exchange.
        const saved = journal()
        if (saved) {
            try {
                const receipt = JSON.parse(saved) as Receipt
                if (snapshot.revision !== receipt.expectedRevision) journal(null)
            } catch { /* An invalid journal stays recoverable through an explicit new action. */ }
        }
        return accepted
    }
    async function send(operation: DesktopClaudePlanAction['operation'], attemptId: string | null, signal: AbortSignal, secret?: string) {
        const snapshot = current ?? await read(signal)
        if (snapshot.attemptId !== attemptId) throw new Error('This Claude sign-in changed. Check its saved state.')
        const guard = { requestId: crypto.randomUUID(), attemptId, expectedRevision: snapshot.revision }
        const action = operation === 'complete' ? { ...guard, operation, code: secret! } : operation === 'token' ? { ...guard, operation, token: secret! } : { ...guard, operation }
        journal(JSON.stringify({ ...guard, operation }))
        const response = await fetch('/api/desktop/claude-login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action), signal })
        if (!response.ok) throw new Error('Claude sign-in could not be confirmed. Check its saved state before trying again.')
        const value = await response.json(), next = desktopClaudePlanSnapshotSchema.parse(value.status)
        signal.throwIfAborted()
        journal(null)
        return accept(next, value.providers)
    }
    return {
        start: (attemptId, signal) => send('start', attemptId, signal),
        reconcile: (_attemptId, signal) => read(signal),
        submit: (attemptId, code, signal) => send('complete', attemptId, signal, code),
        token: (attemptId, token, signal) => send('token', attemptId, signal, token),
        disconnect: (attemptId, signal) => send('disconnect', attemptId, signal),
        cancel: async (attemptId, signal) => {
            // Fetching a newer revision is safe only for the exact attempt captured by the caller.
            // Never discover a different latest attempt and cancel it when an old dialog closes.
            const snapshot = await read(signal)
            const pendingPhase = snapshot.pendingAttempt?.phase ?? snapshot.phase
            if (snapshot.attemptId !== attemptId || !['waiting', 'checking'].includes(pendingPhase)) return snapshot
            return send('cancel', attemptId, signal)
        },
    }
}
