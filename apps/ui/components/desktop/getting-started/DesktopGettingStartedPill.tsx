'use client'

import { useEffect, useState } from 'react'

import { DesktopGettingStartedPopover } from '@/components/desktop/getting-started/DesktopGettingStartedPopover'
import { desktopGettingStartedResponseSchema, type DesktopGettingStartedResponse, type DesktopGettingStartedStepId } from '@/lib/desktop/getting-started/progress'
import { onDesktopGettingStartedReopen } from '@/lib/desktop/getting-started/reopen'

type DesktopGettingStartedPillProps = {
    onAddCoworker: () => void
    onModelSettings: () => void
    onOpenSchedules: () => void
}

async function readSnapshot(signal?: AbortSignal): Promise<DesktopGettingStartedResponse | null> {
    const response = await fetch('/api/desktop/getting-started', { method: 'GET', cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal }).catch(() => null)
    if (!response?.ok) return null
    const parsed = desktopGettingStartedResponseSchema.safeParse(await response.json().catch(() => null))
    return parsed.success ? parsed.data : null
}

async function postAction(action: 'dismiss' | 'reopen'): Promise<DesktopGettingStartedResponse | null> {
    const response = await fetch('/api/desktop/getting-started', {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        redirect: 'error',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
    }).catch(() => null)
    if (!response?.ok) return null
    const parsed = desktopGettingStartedResponseSchema.safeParse(await response.json().catch(() => null))
    return parsed.success ? parsed.data : null
}

/** Local checklist. Hidden after dismiss until Control Center asks it to reopen. A failed read shows nothing. */
export function DesktopGettingStartedPill({ onAddCoworker, onModelSettings, onOpenSchedules }: DesktopGettingStartedPillProps) {
    const [snapshot, setSnapshot] = useState<DesktopGettingStartedResponse | null>(null)
    const [open, setOpen] = useState(false)

    useEffect(() => {
        const controller = new AbortController()
        void readSnapshot(controller.signal).then(next => {
            if (!controller.signal.aborted && next) setSnapshot(next)
        })
        return () => controller.abort()
    }, [])

    useEffect(() => onDesktopGettingStartedReopen(() => {
        setOpen(true)
        void postAction('reopen').then(next => { if (next) setSnapshot(next) })
    }), [])

    if (!snapshot || snapshot.dismissed) return null

    const onStep = (id: DesktopGettingStartedStepId) => {
        setOpen(false)
        if (id === 'first_coworker') onAddCoworker()
        else if (id === 'model') onModelSettings()
        else onOpenSchedules()
    }

    return (
        <DesktopGettingStartedPopover
            steps={snapshot.steps}
            open={open}
            onOpenChange={setOpen}
            onStep={onStep}
            onHide={() => {
                setOpen(false)
                void postAction('dismiss').then(next => { if (next?.dismissed) setSnapshot(next) })
            }}
        />
    )
}
