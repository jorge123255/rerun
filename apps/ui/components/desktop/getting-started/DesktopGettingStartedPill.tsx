'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { DesktopGettingStartedPopover } from '@/components/desktop/getting-started/DesktopGettingStartedPopover'
import { desktopGettingStartedResponseSchema, type DesktopGettingStartedResponse, type DesktopGettingStartedStepId } from '@/lib/desktop/getting-started/progress'
import { onDesktopGettingStartedReopen } from '@/lib/desktop/getting-started/reopen'

type DesktopGettingStartedPillProps = {
    workspaceId: number
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

async function postAction(action: 'dismiss' | 'reopen', signal: AbortSignal): Promise<DesktopGettingStartedResponse | null> {
    const response = await fetch('/api/desktop/getting-started', {
        method: 'POST',
        signal,
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
export function DesktopGettingStartedPill({ workspaceId, onAddCoworker, onModelSettings, onOpenSchedules }: DesktopGettingStartedPillProps) {
    const [snapshot, setSnapshot] = useState<DesktopGettingStartedResponse | null>(null)
    const [open, setOpen] = useState(false)
    const pending = useRef<AbortController | null>(null)
    const refresh = useCallback(async (action?: 'dismiss' | 'reopen') => {
        pending.current?.abort()
        const controller = new AbortController()
        pending.current = controller
        const next = action ? await postAction(action, controller.signal) : await readSnapshot(controller.signal)
        if (controller.signal.aborted || next?.workspaceId !== workspaceId) return
        setSnapshot(next)
        if (action === 'reopen' && !next.dismissed) setOpen(true)
    }, [workspaceId])

    useEffect(() => {
        void refresh()
        const stop = onDesktopGettingStartedReopen(() => { void refresh('reopen') })
        return () => { stop(); pending.current?.abort() }
    }, [refresh])

    if (snapshot?.workspaceId !== workspaceId || snapshot.dismissed) return null

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
            onOpenChange={next => { setOpen(next); if (next) void refresh() }}
            onStep={onStep}
            onHide={() => {
                setOpen(false)
                void refresh('dismiss')
            }}
        />
    )
}
