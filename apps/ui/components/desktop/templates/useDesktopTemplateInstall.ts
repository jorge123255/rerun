'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { DesktopTemplateRequestError, type DesktopTemplatesClient } from '@/lib/desktop/templates-client'
import type { DesktopTemplateDetail, DesktopTemplateInstallIntent, DesktopTemplateInstallReceipt } from './types'

export function useDesktopTemplateInstall({ client, template, resume = null, onInstalled, onInterrupted }: {
    client: DesktopTemplatesClient
    template: DesktopTemplateDetail
    resume?: DesktopTemplateInstallIntent | null
    onInstalled: (receipt: DesktopTemplateInstallReceipt) => void
    onInterrupted?: (intent: DesktopTemplateInstallIntent | null) => void
}) {
    const owner = useMemo(() => ({}), [client, template.templateId, template.revision])
    const activeOwner = useRef(owner)
    activeOwner.current = owner
    const callbacks = useRef({ onInstalled, onInterrupted })
    callbacks.current = { onInstalled, onInterrupted }
    const [stateOwner, setStateOwner] = useState(owner)
    const [busy, setBusy] = useState(false)
    const [checking, setChecking] = useState(true)
    const [readFailed, setReadFailed] = useState(false)
    const [cleanupPending, setCleanupPending] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [receipt, setReceipt] = useState<DesktopTemplateInstallReceipt | null>(null)
    const running = useRef<object | null>(null)
    const ready = useRef<object | null>(null)
    const epoch = useRef(0)
    const resumed = useRef(resume?.templateId === template.templateId && resume.revision === template.revision ? resume : null)

    async function refresh() {
        if (running.current === owner) return
        const request = ++epoch.current
        const current = () => activeOwner.current === owner && epoch.current === request
        ready.current = null
        setStateOwner(owner)
        setChecking(true)
        setReadFailed(false)
        setError(null)
        try {
            const result = await client.currentInstall(template)
            if (!current()) return
            const previousIntent = resumed.current
            setCleanupPending(result.status === 'pending' && result.cleanupPending === true)
            if (result.status === 'installed') {
                setReceipt({ receiptId: result.receiptId, coworkers: result.coworkers })
                resumed.current = null
            } else {
                setReceipt(null)
                resumed.current = result.status === 'pending' ? { templateId: result.templateId, revision: result.revision, requestId: result.requestId } : null
                if (resumed.current) setError(result.status === 'pending' && result.cleanupPending ? 'Cleanup is unfinished. Retry cleanup of this same cancelled installation.' : 'The previous installation needs confirmation. Retry to finish that same installation.')
            }
            if (previousIntent?.requestId !== resumed.current?.requestId) callbacks.current.onInterrupted?.(resumed.current)
            ready.current = owner
        } catch {
            if (!current()) return
            setReceipt(null)
            setReadFailed(true)
            setError('Could not check the previous installation. Try again before using this template.')
        } finally {
            if (current()) setChecking(false)
        }
    }

    useEffect(() => {
        setReceipt(null)
        setBusy(false)
        void refresh()
        return () => { epoch.current++; ready.current = null }
        // The template identity owns this read; callbacks are read through their current ref.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [owner])

    async function run(again = false) {
        if (running.current === owner || ready.current !== owner) return
        if ((receipt && !again) || (!receipt && again)) return
        const request = ++epoch.current
        const current = () => activeOwner.current === owner && epoch.current === request
        running.current = owner
        setBusy(true)
        setError(null)
        const pending = !again ? resumed.current : null
        try {
            const work = client.install(template, again ? { again: true } : pending ? { requestId: pending.requestId } : {})
            const intent = pending ?? client.pendingInstall(template)
            if (intent) {
                resumed.current = intent
                callbacks.current.onInterrupted?.(intent)
            }
            let result: DesktopTemplateInstallReceipt
            try {
                result = await work
            } catch (cause) {
                if (!current()) return
                const definite = cause instanceof DesktopTemplateRequestError && cause.definite
                resumed.current = definite ? null : client.pendingInstall(template) ?? resumed.current
                if (!definite) setReceipt(null)
                setError(cause instanceof Error ? cause.message : 'Could not confirm the installation. Retry to finish the same attempt.')
                callbacks.current.onInterrupted?.(resumed.current)
                return
            }
            if (!current()) return
            callbacks.current.onInstalled({ receiptId: result.receiptId, coworkers: result.coworkers })
            setReceipt(result)
            resumed.current = null
            callbacks.current.onInterrupted?.(null)
        } finally {
            if (running.current === owner) running.current = null
            if (current()) setBusy(false)
        }
    }

    async function rollback() {
        if (running.current === owner || ready.current !== owner || !resumed.current || receipt) return
        const request = ++epoch.current, intent = resumed.current
        const current = () => activeOwner.current === owner && epoch.current === request
        running.current=owner; setBusy(true); setError(null); setCleanupPending(true)
        try {
            await client.rollback(template,intent.requestId)
            if (!current()) return
            resumed.current=null; setCleanupPending(false); callbacks.current.onInterrupted?.(null)
        } catch (cause) { if(current()) setError(cause instanceof Error ? cause.message : 'Could not finish cleanup. Retry this same cleanup.') }
        finally { if(running.current===owner)running.current=null; if(current())setBusy(false) }
    }

    const visible = stateOwner === owner
    return {
        busy: !visible || busy || checking,
        checking: !visible || checking,
        readFailed: visible && readFailed,
        error: visible ? error : null,
        receipt: visible ? receipt : null,
        interrupted: visible && error !== null && receipt === null && resumed.current !== null,
        refresh,
        cleanupPending: visible && cleanupPending,
        rollback,
        run: () => cleanupPending ? rollback() : run(false),
        again: () => run(true),
    }
}
