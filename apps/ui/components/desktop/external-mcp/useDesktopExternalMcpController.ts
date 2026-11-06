'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
    EXTERNAL_MCP_COPY,
    EXTERNAL_MCP_DEFAULT_SCOPES,
    EXTERNAL_MCP_NAME_MAX,
    EXTERNAL_MCP_SCOPES,
    externalMcpDisplayedSecret,
    type ExternalMcpCreateInput,
    type ExternalMcpKeyView,
    type ExternalMcpListenerView,
    type ExternalMcpScope,
} from '@rerun/contracts'
import type { DesktopExternalMcpAttempt } from '@/lib/desktop/external-mcp/attempts'
import type { DesktopExternalMcpDriver } from '@/lib/desktop/external-mcp/driver'
import { toast } from 'sonner'

const definiteCreateRefusals = new Set(['name_required', 'name_too_long', 'too_many_keys', 'invalid', 'scope_missing', 'scope_refused', 'expired'])
const sameAttempt = (left: DesktopExternalMcpAttempt, right: DesktopExternalMcpAttempt) => left.kind === right.kind && left.input.requestId === right.input.requestId

export function useDesktopExternalMcpController({ workspaceId, open, driver }: { workspaceId: number; open: boolean; driver: DesktopExternalMcpDriver }) {
    const [keys, setKeys] = useState<ExternalMcpKeyView[]>([])
    const [listener, setListener] = useState<ExternalMcpListenerView | null>(null)
    const [attempts, setAttempts] = useState<DesktopExternalMcpAttempt[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [draft, setDraft] = useState('')
    const [scopes, setScopes] = useState<ExternalMcpScope[]>([...EXTERNAL_MCP_DEFAULT_SCOPES])
    const [expiresInput, setExpiresInput] = useState('')
    const [creating, setCreating] = useState(false)
    const [createdSecret, setCreatedSecret] = useState<string | null>(null)
    const [revoking, setRevoking] = useState<ExternalMcpKeyView | null>(null)
    const [revokeBusy, setRevokeBusy] = useState(false)
    const [revokeError, setRevokeError] = useState<string | null>(null)
    const [listenerBusy, setListenerBusy] = useState(false)
    const mounted = useRef(false)
    const generation = useRef(0)
    const reads = useRef<AbortController | null>(null)
    const mutations = useRef(new Set<AbortController>())

    const current = useCallback((value: number) => mounted.current && generation.current === value, [])
    const forgetMutation = useCallback((controller: AbortController) => { mutations.current.delete(controller) }, [])
    const nextMutation = useCallback(() => {
        const controller = new AbortController()
        mutations.current.add(controller)
        return controller
    }, [])
    const replaceAttempt = useCallback((attempt: DesktopExternalMcpAttempt) => {
        setAttempts(current => [...current.filter(item => item.kind !== attempt.kind || (item.kind === 'revoke' && attempt.kind === 'revoke' && item.input.keyId !== attempt.input.keyId) || (item.kind !== 'revoke' && attempt.kind === 'revoke')), attempt])
    }, [])
    const removeAttempt = useCallback((attempt: DesktopExternalMcpAttempt) => {
        setAttempts(current => current.filter(item => !sameAttempt(item, attempt)))
    }, [])

    const refresh = useCallback(async (value: number, signal: AbortSignal) => {
        const [nextKeys, nextListener] = await Promise.all([driver.list(workspaceId, signal), driver.listener(signal)])
        if (current(value)) {
            setKeys(nextKeys.keys)
            setListener(nextListener)
        }
    }, [current, driver, workspaceId])

    const load = useCallback(async (value: number, signal: AbortSignal) => {
        setLoading(true)
        setError(null)
        try {
            const [nextKeys, nextListener, nextAttempts] = await Promise.all([driver.list(workspaceId, signal), driver.listener(signal), driver.attempts.list(workspaceId, signal)])
            if (!current(value)) return
            setKeys(nextKeys.keys)
            setListener(nextListener)
            setAttempts(nextAttempts)
        } catch (cause) {
            if (current(value) && !signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not load API keys.')
        } finally {
            if (current(value)) setLoading(false)
        }
    }, [current, driver, workspaceId])

    useEffect(() => {
        mounted.current = true
        return () => {
            mounted.current = false
            generation.current += 1
            reads.current?.abort()
            for (const controller of mutations.current) controller.abort()
            mutations.current.clear()
        }
    }, [])

    useEffect(() => {
        generation.current += 1
        const value = generation.current
        setCreatedSecret(null)
        setRevoking(null)
        setRevokeError(null)
        if (!open) return
        reads.current?.abort()
        const controller = new AbortController()
        reads.current = controller
        void load(value, controller.signal)
        return () => { controller.abort() }
    }, [open, driver, load])

    const reserve = useCallback(async (attempt: DesktopExternalMcpAttempt, signal: AbortSignal) => {
        const saved = await driver.attempts.reserve(attempt, signal)
        replaceAttempt(saved)
        return saved
    }, [driver, replaceAttempt])

    const acknowledge = useCallback(async (attempt: DesktopExternalMcpAttempt, signal: AbortSignal) => {
        try {
            await driver.attempts.clear(attempt, signal)
            removeAttempt(attempt)
        } catch {
            // A later open reconciles this nonsecret attempt; an already displayed secret is never replayed.
        }
    }, [driver, removeAttempt])

    const create = useCallback(async (existing?: DesktopExternalMcpAttempt & { kind: 'create' }) => {
        if (creating) return
        let input: ExternalMcpCreateInput
        if (existing) input = existing.input
        else {
            const name = draft.trim()
            if (!name) { setError(EXTERNAL_MCP_COPY.nameRequired); return }
            if (name.length > EXTERNAL_MCP_NAME_MAX) { setError(EXTERNAL_MCP_COPY.nameTooLong); return }
            let expiresAt: string | null = null
            if (expiresInput) {
                const parsed = new Date(expiresInput)
                if (!Number.isFinite(parsed.getTime()) || parsed.getTime() <= Date.now()) { setError('Choose a future expiry, or leave it empty.'); return }
                expiresAt = parsed.toISOString()
            }
            input = { requestId: crypto.randomUUID(), workspaceId, name, scopes, expiresAt }
        }
        const value = generation.current
        const controller = nextMutation()
        setCreating(true)
        setError(null)
        const attempt: DesktopExternalMcpAttempt & { kind: 'create' } = existing ?? { kind: 'create', input }
        try {
            if (attempt.input.workspaceId !== workspaceId) throw new Error(EXTERNAL_MCP_COPY.workspace)
            await reserve(attempt, controller.signal)
            const result = await driver.create(attempt.input, controller.signal)
            if (!current(value)) return
            if (!result.ok) {
                setError(result.message)
                if (definiteCreateRefusals.has(result.code)) await acknowledge(attempt, controller.signal)
                return
            }
            const sameScopes = result.key.scopes.length === attempt.input.scopes.length && result.key.scopes.every(scope => attempt.input.scopes.includes(scope))
            if (result.key.workspaceId !== workspaceId || result.key.name !== attempt.input.name || result.key.expiresAt !== attempt.input.expiresAt || !sameScopes || result.receipt.kind !== 'create' || result.receipt.workspaceId !== workspaceId || result.receipt.requestId !== attempt.input.requestId) throw new Error(EXTERNAL_MCP_COPY.changed)
            const secret = externalMcpDisplayedSecret(result)
            await acknowledge(attempt, controller.signal)
            if (!current(value)) return
            setDraft('')
            setScopes([...EXTERNAL_MCP_DEFAULT_SCOPES])
            setExpiresInput('')
            if (secret) setCreatedSecret(secret)
            else setError(EXTERNAL_MCP_COPY.secretDiscarded)
            await refresh(value, controller.signal)
        } catch {
            if (current(value) && !controller.signal.aborted) setError('Could not confirm the key. Retry the same request; no new key was started.')
        } finally {
            forgetMutation(controller)
            if (current(value)) setCreating(false)
        }
    }, [acknowledge, creating, current, draft, driver, expiresInput, forgetMutation, nextMutation, refresh, reserve, scopes, workspaceId])

    const revoke = useCallback(async () => {
        if (!revoking || revokeBusy) return
        const key = revoking
        const value = generation.current
        const controller = nextMutation()
        const existing = attempts.find((item): item is DesktopExternalMcpAttempt & { kind: 'revoke' } => item.kind === 'revoke' && item.input.keyId === key.keyId)
        const attempt: DesktopExternalMcpAttempt & { kind: 'revoke' } = existing ?? { kind: 'revoke', input: { requestId: crypto.randomUUID(), workspaceId, keyId: key.keyId } }
        setRevokeBusy(true)
        setRevokeError(null)
        try {
            if (attempt.input.workspaceId !== workspaceId || attempt.input.keyId !== key.keyId) throw new Error(EXTERNAL_MCP_COPY.changed)
            await reserve(attempt, controller.signal)
            const result = await driver.revoke(attempt.input, controller.signal)
            if (!current(value)) return
            if (!result.ok) {
                setRevokeError(result.message)
                if (['not_found', 'revoked'].includes(result.code)) await acknowledge(attempt, controller.signal)
                return
            }
            if (result.key.keyId !== key.keyId || result.key.workspaceId !== workspaceId || result.key.status !== 'revoked' || result.key.revision < key.revision || result.receipt.kind !== 'revoke' || result.receipt.workspaceId !== workspaceId || result.receipt.requestId !== attempt.input.requestId) throw new Error(EXTERNAL_MCP_COPY.changed)
            await acknowledge(attempt, controller.signal)
            if (!current(value)) return
            setRevoking(null)
            toast.success(`${key.name} revoked`)
            await refresh(value, controller.signal)
        } catch (cause) {
            if (current(value) && !controller.signal.aborted) setRevokeError(cause instanceof Error ? cause.message : 'Could not confirm revocation. Retry the same request.')
        } finally {
            forgetMutation(controller)
            if (current(value)) setRevokeBusy(false)
        }
    }, [acknowledge, attempts, current, driver, forgetMutation, nextMutation, refresh, reserve, revokeBusy, revoking, workspaceId])

    const configureListener = useCallback(async (kind: 'enable' | 'disable') => {
        if (listenerBusy) return
        const value = generation.current
        const controller = nextMutation()
        const existing = attempts.find((item): item is DesktopExternalMcpAttempt & { kind: 'enable' | 'disable' } => (item.kind === 'enable' || item.kind === 'disable') && item.kind === kind)
        const attempt: DesktopExternalMcpAttempt & { kind: 'enable' | 'disable' } = existing ?? { kind, input: { requestId: crypto.randomUUID(), workspaceId } }
        setListenerBusy(true)
        setError(null)
        try {
            if (attempt.input.workspaceId !== workspaceId) throw new Error(EXTERNAL_MCP_COPY.workspace)
            await reserve(attempt, controller.signal)
            const result = await (kind === 'enable' ? driver.enable(attempt.input, controller.signal) : driver.disable(attempt.input, controller.signal))
            if (!current(value)) return
            if (!result.ok) { setError(result.message); return }
            if (result.receipt.kind !== kind || result.receipt.workspaceId !== workspaceId || result.receipt.requestId !== attempt.input.requestId || result.listener.workspaceId !== null && result.listener.workspaceId !== workspaceId) throw new Error(EXTERNAL_MCP_COPY.changed)
            await acknowledge(attempt, controller.signal)
            if (current(value)) setListener(result.listener)
        } catch (cause) {
            if (current(value) && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not confirm the listener change. Retry the same request.')
        } finally {
            forgetMutation(controller)
            if (current(value)) setListenerBusy(false)
        }
    }, [acknowledge, attempts, current, driver, forgetMutation, listenerBusy, nextMutation, reserve, workspaceId])

    const pendingCreate = attempts.find((item): item is DesktopExternalMcpAttempt & { kind: 'create' } => item.kind === 'create')
    const pendingRevokes = useMemo(() => new Set(attempts.flatMap(item => item.kind === 'revoke' ? [item.input.keyId] : [])), [attempts])
    const pendingListener = attempts.find((item): item is DesktopExternalMcpAttempt & { kind: 'enable' | 'disable' } => item.kind === 'enable' || item.kind === 'disable')

    return {
        keys, listener, attempts, loading, error, draft, scopes, expiresInput, creating, createdSecret, revoking, revokeBusy, revokeError, listenerBusy,
        pendingCreate, pendingRevokes, pendingListener,
        setDraft, setScopes, setExpiresInput,
        create: () => create(pendingCreate),
        revoke,
        startRevoke: (key: ExternalMcpKeyView) => { setRevoking(key); setRevokeError(null) },
        cancelRevoke: () => { if (!revokeBusy) { setRevoking(null); setRevokeError(null) } },
        configureListener,
        dismissSecret: () => setCreatedSecret(null),
        clearError: () => setError(null),
        retryLoad: () => { const value = generation.current; reads.current?.abort(); const controller = new AbortController(); reads.current = controller; void load(value, controller.signal) },
        scopeOptions: EXTERNAL_MCP_SCOPES,
    }
}
