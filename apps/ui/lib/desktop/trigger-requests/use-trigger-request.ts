'use client'

import { useEffect, useRef, useState } from 'react'
import { createTriggerRequestsClient } from './client'
import { sameTriggerResultOwner } from './projection'
import type { TriggerRequestDecision, TriggerRequestView } from './types'

export function useTriggerRequest(initial: TriggerRequestView, active: boolean, onAccepted: (response: Response, view: TriggerRequestView) => Promise<void>) {
    const [view, setView] = useState(initial), [busy, setBusy] = useState(false), [error, setError] = useState('')
    const latest = useRef({ initial, active, onAccepted }); latest.current = { initial, active, onAccepted }
    const claimed = useRef(false), generation = useRef(0), pending = useRef<AbortController | null>(null)
    const client = useRef(createTriggerRequestsClient(initial.link.sessionId, initial.key))
    useEffect(() => {
        const epoch = ++generation.current
        pending.current?.abort(); claimed.current = false
        client.current = createTriggerRequestsClient(initial.link.sessionId, initial.key)
        setView(initial); setBusy(false); setError('')
        const controller = new AbortController(); pending.current = controller
        void client.current.read(controller.signal).then(next => {
            if (generation.current === epoch && !controller.signal.aborted && next) setView(next)
        }).catch(() => { if (!controller.signal.aborted && generation.current === epoch) setError('The saved webhook request could not be refreshed.') })
        return () => { ++generation.current; controller.abort(); pending.current?.abort() }
    }, [initial.key, active])
    useEffect(() => {
        if (!claimed.current && sameTriggerResultOwner(view.link, initial.link)) setView(initial)
    }, [initial])
    async function perform(action: 'reconcile' | 'stop' | 'decide', decision?: TriggerRequestDecision) {
        if (!latest.current.active || claimed.current || !sameTriggerResultOwner(view.link, latest.current.initial.link)) throw new Error('This webhook result is no longer active')
        claimed.current = true; setBusy(true); setError('')
        const epoch = generation.current, controller = new AbortController(); pending.current = controller
        let admitted = false
        const current = () => epoch === generation.current && !controller.signal.aborted && latest.current.active && sameTriggerResultOwner(view.link, latest.current.initial.link)
        try {
            if (action === 'decide' && decision) {
                const response = await client.current.decide(decision, controller.signal)
                if (!current()) { void response.body?.cancel().catch(() => {}); return }
                admitted = true
                // The parent owns the acknowledged response reader now; visibility changes cancel through that owner.
                if (pending.current === controller) pending.current = null
                setView(value => ({ ...value, phase: 'accepted', request: null, acceptedRunId: response.headers.get('x-run-id') }))
                await latest.current.onAccepted(response, view)
            } else {
                const result = action === 'stop' ? await client.current.stop(controller.signal) : await client.current.reconcile(controller.signal)
                if (current() && result) setView(result)
            }
        } catch {
            if (current()) {
                setError('The acknowledgement could not be confirmed. Check the saved outcome before taking another action.')
                if (action === 'decide' && !admitted) setView(value => ({ ...value, phase: 'uncertain' }))
                if (action === 'stop') setView(value => ({ ...value, phase: 'stop-uncertain' }))
            }
            throw new Error('Webhook acknowledgement unknown. Check the saved outcome.')
        } finally { if (epoch === generation.current) { claimed.current = false; setBusy(false) } }
    }
    return { view, busy, error, decide: (decision: TriggerRequestDecision) => perform('decide', decision),
        reconcile: () => perform('reconcile'), stop: () => perform('stop') }
}
