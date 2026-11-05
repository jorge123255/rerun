'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { desktopAttachmentFieldsOf, type DesktopAttachmentSelection } from '@rerun/contracts'
import { desktopQueuedMessageSchema, type DesktopQueuedMessage, type DesktopQueueWrite } from './queued-message'
import { pendingTabWrite } from './tab-writes'

const changedEvent = 'desktop-queued-message-changed'
type State = { key: string; queued: DesktopQueuedMessage | null; loaded: boolean; error?: string; restoredId: string | null }

export function useDesktopQueuedMessage(agentId: string, sessionId: string | null, tabUid?: string) {
    const scope = useMemo(() => ({ ...(sessionId && { sessionId }), ...(tabUid && { tabUid }) }), [sessionId, tabUid])
    const key = JSON.stringify([agentId, sessionId, tabUid])
    const currentKey = useRef(key)
    const version = useRef(0)
    const fresh = useRef(new Set<string>())
    const uncertain = useRef(new Set<string>())
    const [state, setState] = useState<State>({ key, queued: null, loaded: false, restoredId: null })
    const [pendingKey, setPendingKey] = useState<string | null>(null)
    const url = `/api/desktop/agents/${encodeURIComponent(agentId)}/queue`
    useEffect(() => { currentKey.current = key }, [key])

    const accept = useCallback(async (response: Response, started: number, confirmedEnqueueId?: string) => {
        const body = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : 'Could not save the queued message. Try again.')
        if (!('queued' in body)) throw new Error('Could not load the queued message.')
        let queued = body.queued === null ? null : desktopQueuedMessageSchema.parse(body.queued)
        if (confirmedEnqueueId && queued?.id === confirmedEnqueueId) {
            uncertain.current.delete(confirmedEnqueueId)
            fresh.current.add(confirmedEnqueueId)
        }
        // A saved enqueue whose acknowledgement was lost still has its text in the composer.
        // Recover it for review even if its original run remains active; adopting it as fresh
        // would send it while leaving a second, apparently unsent copy in that composer.
        if (queued?.state === 'waiting' && uncertain.current.has(queued.id)) queued = { ...queued, state: 'review' }
        if (currentKey.current === key && version.current === started) {
            setState({ key, queued, loaded: true, restoredId: queued && !fresh.current.has(queued.id) ? queued.id : null })
        }
        return queued
    }, [key])

    const refresh = useCallback(async (signal?: AbortSignal) => {
        if (!sessionId && !tabUid) {
            if (currentKey.current === key) setState({ key, queued: null, loaded: true, restoredId: null })
            return null
        }
        const started = ++version.current
        try {
            if (tabUid) await pendingTabWrite(agentId)
            const response = await fetch(`${url}?${new URLSearchParams(scope).toString()}`, { cache: 'no-store', signal })
            return await accept(response, started)
        } catch (cause) {
            if (!signal?.aborted && currentKey.current === key && version.current === started) {
                setState(previous => ({ ...(previous.key === key ? previous : { key, queued: null, restoredId: null }), loaded: true, error: cause instanceof Error ? cause.message : 'Could not load the queued message.' }))
            }
            return null
        }
    }, [accept, agentId, key, scope, sessionId, tabUid, url])

    useEffect(() => {
        const controller = new AbortController()
        void refresh(controller.signal)
        const onChange = () => { if (!controller.signal.aborted) void refresh(controller.signal) }
        window.addEventListener(changedEvent, onChange)
        window.addEventListener('focus', onChange)
        const timer = setInterval(onChange, 3000)
        return () => { controller.abort(); clearInterval(timer); window.removeEventListener(changedEvent, onChange); window.removeEventListener('focus', onChange) }
    }, [refresh])

    const write = useCallback(async (input: DesktopQueueWrite) => {
        const started = ++version.current
        setPendingKey(key)
        try {
            if (tabUid) await pendingTabWrite(agentId)
            const queued = await accept(await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }), started, input.action === 'enqueue' ? input.item.id : undefined)
            window.dispatchEvent(new Event(changedEvent))
            return queued
        } catch (cause) {
            if (currentKey.current === key) setState(previous => ({ ...previous, key, error: cause instanceof Error ? cause.message : 'Could not save the queued message. Try again.' }))
            throw cause
        } finally { setPendingKey(current => current === key ? null : current) }
    }, [accept, agentId, key, tabUid, url])

    const queued = state.key === key ? state.queued : null
    const enqueue = useCallback(async (text: string, attachments: readonly DesktopAttachmentSelection[], behindRunId: string | null) => {
        const item: DesktopQueuedMessage = { id: crypto.randomUUID(), text, ...desktopAttachmentFieldsOf(attachments), createdAt: Date.now(), behindRunId, state: 'waiting' }
        uncertain.current.add(item.id)
        return write({ action: 'enqueue', scope, expectedId: queued?.id ?? null, item })
    }, [queued?.id, scope, write])
    const action = useCallback((action: 'attempt' | 'review' | 'remove', id: string) => write({ action, scope, id }), [scope, write])
    const adopt = useCallback((id: string) => {
        fresh.current.add(id)
        setState(previous => previous.key === key && previous.queued?.id === id ? { ...previous, restoredId: null } : previous)
    }, [key])

    return { key, queued, loaded: state.key === key && state.loaded, error: state.key === key ? state.error : undefined,
        restoredId: state.key === key ? state.restoredId : null, pending: pendingKey === key, enqueue, action, refresh, adopt }
}
