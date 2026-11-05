'use client'

import { useRef, useState } from 'react'
import { DesktopTemplateRequestError, type DesktopTemplatesClient } from '@/lib/desktop/templates-client'
import type { DesktopTemplateDetail, DesktopTemplateInstallIntent, DesktopTemplateInstallReceipt } from './types'

export function useDesktopTemplateInstall({ client, template, resume = null, onInstalled, onInterrupted }: {
    client: DesktopTemplatesClient
    template: DesktopTemplateDetail
    resume?: DesktopTemplateInstallIntent | null
    onInstalled: (receipt: DesktopTemplateInstallReceipt) => void
    onInterrupted?: (intent: DesktopTemplateInstallIntent | null) => void
}) {
    const resumable = resume?.templateId === template.templateId && resume.revision === template.revision ? resume : null
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(resumable ? 'The previous installation needs confirmation.' : null)
    const [receipt, setReceipt] = useState<DesktopTemplateInstallReceipt | null>(null)
    const running = useRef(false)
    const resumed = useRef(resumable)
    if (resumable) resumed.current = resumable

    async function run(again = false) {
        if (running.current) return
        if (receipt && !again) return
        running.current = true
        setBusy(true)
        setError(null)
        const pending = !again ? resumed.current : null
        try {
            const request = client.install(template, again ? { again: true } : pending ? { requestId: pending.requestId } : {})
            const intent = pending ?? client.pendingInstall(template)
            if (intent) {
                resumed.current = intent
                onInterrupted?.(intent)
            }
            let result: DesktopTemplateInstallReceipt
            try {
                result = await request
            } catch (cause) {
                setError(cause instanceof Error ? cause.message : 'Installation acknowledgement is unknown. Retry the same attempt.')
                if (cause instanceof DesktopTemplateRequestError && cause.definite) resumed.current = null
                onInterrupted?.(resumed.current)
                return
            }
            onInstalled({ receiptId: result.receiptId, coworkers: result.coworkers })
            setReceipt(result)
            resumed.current = null
            onInterrupted?.(null)
        } finally {
            running.current = false
            setBusy(false)
        }
    }

    return {
        busy,
        error,
        receipt,
        interrupted: error !== null && receipt === null && resumed.current !== null,
        run: () => run(false),
        again: () => run(true),
    }
}
