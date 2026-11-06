import { randomUUID } from 'node:crypto'
import {
    DESKTOP_CLAUDE_PLAN_AUTH_LIFETIME_MS,
    type DesktopClaudePlanAttempt,
    type DesktopClaudePlanAttemptAction,
    type DesktopClaudePlanCompleteInput,
    type DesktopClaudePlanCredentialCustody,
    type DesktopClaudePlanOAuth,
    type DesktopClaudePlanAttemptStore,
} from '@rerun/contracts'

type Ports = { oauth: DesktopClaudePlanOAuth; custody: DesktopClaudePlanCredentialCustody; outcomes: DesktopClaudePlanAttemptStore }

function next(attempt: DesktopClaudePlanAttempt, patch: Partial<DesktopClaudePlanAttempt>, now: () => string): DesktopClaudePlanAttempt {
    return { ...attempt, ...patch, revision: String(Number(attempt.revision) + 1), updatedAt: now() }
}

async function digest(value: unknown): Promise<string> {
    const bytes = new TextEncoder().encode(JSON.stringify(value))
    const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(hash), item => item.toString(16).padStart(2, '0')).join('')
}

export function createDesktopClaudePlanAuth(ports: Ports, options: { now?: () => string } = {}) {
    const now = options.now ?? (() => new Date().toISOString())

    async function start(agentId: string): Promise<DesktopClaudePlanAttempt> {
        const active = await ports.outcomes.active(agentId)
        if (active && ['waiting', 'checking'].includes(active.phase)) return active
        if (active?.phase === 'connected' && await ports.custody.load(agentId)) return active
        const oauth = await ports.oauth.start()
        const createdAt = now()
        const attempt: DesktopClaudePlanAttempt = {
            attemptId: await digest([agentId, oauth, createdAt, randomUUID()]),
            agentId,
            revision: '1',
            phase: 'waiting',
            authorizeUrl: oauth.authorizeUrl,
            verifier: oauth.verifier,
            state: oauth.state,
            createdAt,
            updatedAt: createdAt,
            expiresAt: new Date(Date.parse(createdAt) + DESKTOP_CLAUDE_PLAN_AUTH_LIFETIME_MS).toISOString(),
        }
        const existing = await ports.outcomes.begin(attempt)
        return existing === 'execute' ? ports.outcomes.complete(attempt).then(() => attempt) : existing
    }

    async function status(attemptId: string): Promise<DesktopClaudePlanAttempt | null> {
        const attempt = await ports.outcomes.read(attemptId)
        if (!attempt || attempt.phase !== 'waiting' || !attempt.expiresAt || Date.parse(attempt.expiresAt) > Date.parse(now())) return attempt
        const expired = next(attempt, { phase: 'expired', message: 'This sign-in code expired. Start a new one.' }, now)
        await ports.outcomes.complete(expired)
        return expired
    }

    async function complete(input: DesktopClaudePlanCompleteInput, signal?: AbortSignal): Promise<DesktopClaudePlanAttempt> {
        const current = await ports.outcomes.read(input.attemptId)
        if (!current || current.phase !== 'waiting' || current.verifier !== input.verifier || current.state !== input.state) throw new Error('This Claude sign-in is no longer waiting for a code. Start a new one.')
        if (current.expiresAt && Date.parse(current.expiresAt) <= Date.parse(now())) {
            const expired = next(current, { phase: 'expired', message: 'This sign-in code expired. Start a new one.' }, now)
            await ports.outcomes.complete(expired)
            return expired
        }
        const checking = next(current, { phase: 'checking' }, now)
        await ports.outcomes.complete(checking)
        try {
            const credential = await ports.oauth.exchange({ rawCode: input.rawCode, verifier: input.verifier, state: input.state, signal: signal ?? new AbortController().signal })
            const saved = await ports.custody.save(current.agentId, credential)
            const connected = next(checking, { phase: 'connected', credentialRevision: saved.revision }, now)
            await ports.outcomes.complete(connected)
            return connected
        } catch (error) {
            const failed = next(checking, { phase: 'error', message: error instanceof Error ? error.message.slice(0, 500) : 'Claude sign-in failed.' }, now)
            await ports.outcomes.complete(failed)
            return failed
        }
    }

    async function cancel(input: DesktopClaudePlanAttemptAction): Promise<DesktopClaudePlanAttempt> {
        const current = await ports.outcomes.read(input.attemptId)
        if (!current || current.revision !== input.expectedRevision) throw new Error('This Claude sign-in changed. Refresh it and try again.')
        if (!['waiting', 'checking'].includes(current.phase)) return current
        const cancelled = next(current, { phase: 'cancelled' }, now)
        await ports.outcomes.complete(cancelled)
        return cancelled
    }

    async function disconnect(input: DesktopClaudePlanAttemptAction): Promise<DesktopClaudePlanAttempt> {
        const current = await ports.outcomes.read(input.attemptId)
        if (!current || current.revision !== input.expectedRevision) throw new Error('This Claude connection changed. Refresh it and try again.')
        if (current.phase !== 'connected') return current
        await ports.custody.clear(current.agentId)
        const disconnected = next(current, { phase: 'disconnected', credentialRevision: undefined }, now)
        await ports.outcomes.complete(disconnected)
        return disconnected
    }

    return { start, status, complete, cancel, disconnect }
}
