'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { DesktopCompanyProfileAttempt, DesktopCompanyProfileIdentity, DesktopCompanyProfileView, DesktopForemanChatRef } from '@rerun/contracts'
import { isDesktopQuitting, subscribeDraftShutdown } from '@/lib/desktop/draft-writes'
import type { DesktopCompanyProfileClient } from './client'

export type DesktopCompanyProfileKind = 'decide' | 'enrich'
type Operation = { kind: DesktopCompanyProfileKind; identity: DesktopCompanyProfileIdentity; requestId: string; collect: boolean }

const sameIdentity = (a: DesktopCompanyProfileIdentity, b: DesktopCompanyProfileIdentity) => JSON.stringify(a) === JSON.stringify(b)
const identityFor = (view: DesktopCompanyProfileView | null, kind: DesktopCompanyProfileKind) => kind === 'decide' ? view?.decisionIdentity ?? null : view?.enrichmentIdentity ?? null
const attemptFor = (view: DesktopCompanyProfileView | null, kind: DesktopCompanyProfileKind) => kind === 'decide' ? view?.decision ?? null : view?.enrichment ?? null

export function useDesktopCompanyProfile({ chat, client, active = true, draftRevision }: {
    chat: DesktopForemanChatRef
    client: DesktopCompanyProfileClient
    active?: boolean
    draftRevision: number
}) {
    const scope = `${chat.workspaceId}:${chat.chatId}`
    const [view, setView] = useState<DesktopCompanyProfileView | null>(null)
    const [loading, setLoading] = useState(active)
    const [error, setError] = useState<string | null>(null)
    const [pending, setPending] = useState<Record<DesktopCompanyProfileKind, boolean>>({ decide: false, enrich: false })
    const latest = useRef({ view, active, draftRevision, scope })
    latest.current = { view, active, draftRevision, scope }
    const epoch = useRef(0)
    const readVersion = useRef(0)
    const controllers = useRef(new Set<AbortController>())
    const operations = useRef(new Map<DesktopCompanyProfileKind, Operation>())
    const running = useRef(new Map<DesktopCompanyProfileKind, Promise<DesktopCompanyProfileAttempt | null>>())

    const read = useCallback(async (): Promise<boolean> => {
        const generation = epoch.current
        const version = ++readVersion.current
        const controller = new AbortController()
        controllers.current.add(controller)
        try {
            const result = await client.read(chat, controller.signal)
            const identities = [result.decisionIdentity, result.enrichmentIdentity]
            if (identities.some(identity => identity && identity.draftRevision !== latest.current.draftRevision)) return false
            if (generation !== epoch.current || version !== readVersion.current || latest.current.scope !== scope || !latest.current.active || controller.signal.aborted) return false
            setView(result)
            setError(null)
            return true
        } catch (cause) {
            if (generation === epoch.current && version === readVersion.current && latest.current.active && !controller.signal.aborted) {
                setError(cause instanceof Error ? cause.message : 'Company profile is unavailable.')
            }
            return false
        } finally {
            controllers.current.delete(controller)
            if (generation === epoch.current && version === readVersion.current) setLoading(false)
        }
    }, [client, chat.workspaceId, chat.chatId, scope])

    useEffect(() => {
        epoch.current++
        readVersion.current++
        for (const controller of controllers.current) controller.abort()
        controllers.current.clear()
        operations.current.clear()
        running.current.clear()
        setView(null)
        setError(null)
        setPending({ decide: false, enrich: false })
        setLoading(active)
        if (active && !isDesktopQuitting()) void read()
        return () => {
            epoch.current++
            readVersion.current++
            for (const controller of controllers.current) controller.abort()
            controllers.current.clear()
        }
    }, [scope, active, draftRevision, read])

    useEffect(() => subscribeDraftShutdown(() => {
        epoch.current++
        readVersion.current++
        for (const controller of controllers.current) controller.abort()
        controllers.current.clear()
        if (!isDesktopQuitting() && latest.current.active) void read()
    }), [read])

    const decisionPending = view?.decision?.status === 'pending'
    const enrichmentPending = view?.enrichment?.status === 'pending'
    useEffect(() => {
        if (!active || (!decisionPending && !enrichmentPending)) return
        const timer = setInterval(() => { if (!isDesktopQuitting()) void read() }, 2000)
        return () => clearInterval(timer)
    }, [active, decisionPending, enrichmentPending, read])

    const perform = useCallback((kind: DesktopCompanyProfileKind, collect: boolean, supplied?: DesktopCompanyProfileIdentity): Promise<DesktopCompanyProfileAttempt | null> => {
        const existingRun = running.current.get(kind)
        if (existingRun) return existingRun
        const identity = supplied ?? identityFor(latest.current.view, kind)
        if (!identity || identity.draftRevision !== latest.current.draftRevision || !latest.current.active || isDesktopQuitting()) return Promise.resolve(null)
        const currentIdentity = identityFor(latest.current.view, kind)
        if (!currentIdentity || !sameIdentity(identity, currentIdentity)) return Promise.resolve(null)
        const currentAttempt = attemptFor(latest.current.view, kind)
        const previous = operations.current.get(kind)
        let operation = previous?.kind === kind && sameIdentity(previous.identity, identity) ? previous : null
        if (!operation) {
            const replay = currentAttempt && sameIdentity(currentAttempt.identity, identity) && ['pending', 'succeeded'].includes(currentAttempt.status)
            operation = { kind, identity, collect, requestId: replay ? currentAttempt!.requestId : crypto.randomUUID() }
            operations.current.set(kind, operation)
        }
        const currentOperation = operation
        const generation = epoch.current
        const controller = new AbortController()
        controllers.current.add(controller)
        setPending(value => ({ ...value, [kind]: true }))
        setError(null)
        const work = (async () => {
            try {
                const input = { requestId: currentOperation.requestId, identity: currentOperation.identity }
                const result = kind === 'decide'
                    ? await client.decide(input, controller.signal)
                    : await client.enrich({ ...input, collect: currentOperation.collect }, controller.signal)
                if (result.requestId !== currentOperation.requestId || result.kind !== kind || !sameIdentity(result.identity, currentOperation.identity)) {
                    throw new Error('Company analysis acknowledged another request. Reconcile it before trying again.')
                }
                if (generation !== epoch.current || latest.current.scope !== scope || controller.signal.aborted) return null
                operations.current.delete(kind)
                await read()
                return result
            } catch (cause) {
                if (generation === epoch.current && latest.current.scope === scope && !controller.signal.aborted) {
                    setError(cause instanceof Error ? cause.message : 'Company analysis could not be confirmed. Retry the same request.')
                    await read()
                }
                return null
            } finally {
                controllers.current.delete(controller)
                running.current.delete(kind)
                if (generation === epoch.current) setPending(value => ({ ...value, [kind]: false }))
            }
        })()
        running.current.set(kind, work)
        return work
    }, [client, read, scope])

    const decide = useCallback((identity?: DesktopCompanyProfileIdentity) => perform('decide', false, identity), [perform])
    const enrich = useCallback((collect = true, identity?: DesktopCompanyProfileIdentity) => perform('enrich', collect, identity), [perform])

    const stop = useCallback(async (kind?: DesktopCompanyProfileKind): Promise<boolean> => {
        const targets = new Map<string, DesktopCompanyProfileKind>()
        for (const operation of operations.current.values()) {
            if (!kind || operation.kind === kind) targets.set(operation.requestId, operation.kind)
        }
        for (const candidate of ['decide', 'enrich'] as const) {
            if (kind && candidate !== kind) continue
            const attempt = attemptFor(latest.current.view, candidate)
            if (attempt?.status === 'pending') targets.set(attempt.requestId, candidate)
        }
        if (!targets.size) return true
        let confirmed = true
        for (const [requestId] of targets) {
            try {
                const result = await client.cancel({ requestId, chat })
                if (result.requestId !== requestId || result.status !== 'cancelled') confirmed = false
            } catch (cause) {
                confirmed = false
                setError(cause instanceof Error ? cause.message : 'Stop was not confirmed. Retry Stop.')
            }
        }
        await read()
        return confirmed
    }, [client, chat, read])

    const invalidate = useCallback(() => {
        epoch.current++
        readVersion.current++
        for (const controller of controllers.current) controller.abort()
        controllers.current.clear()
        setView(null)
        setError(null)
    }, [])

    return {
        view,
        loading,
        error,
        pending,
        read,
        decide,
        enrich,
        stop,
        invalidate,
    }
}

export type DesktopCompanyProfileController = ReturnType<typeof useDesktopCompanyProfile>
export type { DesktopCompanyProfileAttempt }
