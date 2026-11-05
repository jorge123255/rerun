'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { SubRunBlock } from '@/components/chat/SubRunBlock'
import { Button } from '@/components/ui/button'
import type { DesktopCoworkerCallOpenTarget, DesktopCoworkerCallSnapshot, DesktopCoworkerCallsClient } from '@/lib/desktop/coworker-calls-client'
import { desktopCoworkerCallProgress, desktopCoworkerCallState, isDesktopCoworkerCallLive } from './coworker-call-progress'

export function DesktopCoworkerCallBlock({ client, call, active = true, onOpenTarget, onChange }: {
    client: DesktopCoworkerCallsClient
    call: DesktopCoworkerCallSnapshot
    active?: boolean
    onOpenTarget?: (target: DesktopCoworkerCallOpenTarget) => Promise<void>
    onChange?: (call: DesktopCoworkerCallSnapshot) => void
}) {
    const progress = useMemo(() => desktopCoworkerCallProgress(call), [call])
    const [action, setAction] = useState<'open' | 'stop' | null>(null)
    const [openError, setOpenError] = useState<string | null>(null)
    const [stopError, setStopError] = useState<string | null>(null)
    const [stopReset, setStopReset] = useState(0)
    const request = useRef<AbortController | null>(null)
    const mounted = useRef(true)

    useEffect(() => {
        mounted.current = true
        return () => { mounted.current = false; request.current?.abort() }
    }, [])
    useEffect(() => {
        request.current?.abort()
        request.current = null
        setAction(null)
        setOpenError(null)
        setStopError(null)
    }, [client, call.callId, call.parentRunId, call.toolCallId])

    const stop = async (taskId: string) => {
        if (!active || !onChange || request.current) return
        if (taskId !== call.callId) { setStopError('This coworker call changed. Refresh it before stopping.'); return }
        const controller = new AbortController()
        request.current = controller
        setAction('stop')
        setStopError(null)
        try {
            const stopped = await client.stop(call, controller.signal)
            if (mounted.current && !controller.signal.aborted) onChange(stopped)
        } catch (cause) {
            if (mounted.current && !controller.signal.aborted) {
                setStopError(cause instanceof Error ? cause.message : 'Could not stop the coworker call.')
                setStopReset(value => value + 1)
            }
        } finally {
            if (request.current === controller) request.current = null
            if (mounted.current && !controller.signal.aborted) setAction(null)
        }
    }

    const open = async () => {
        if (!active || !onOpenTarget || request.current) return
        const controller = new AbortController()
        request.current = controller
        setAction('open')
        setOpenError(null)
        try {
            await client.openTarget(call, onOpenTarget, controller.signal)
        } catch (cause) {
            if (mounted.current && !controller.signal.aborted) setOpenError(cause instanceof Error ? cause.message : 'Could not open the coworker chat.')
        } finally {
            if (request.current === controller) request.current = null
            if (mounted.current && !controller.signal.aborted) setAction(null)
        }
    }

    return <div className="flex min-w-0 w-full flex-col items-start gap-1">
        <SubRunBlock
            key={`${call.callId}:${stopReset}`}
            toolName="call_agent"
            state={desktopCoworkerCallState(call)}
            progress={progress}
            dense={!isDesktopCoworkerCallLive(call)}
            onStopTask={active && onChange ? taskId => { void stop(taskId) } : undefined}
        />
        {call.status === 'waiting-human' && <p role="status" className="break-words text-xs text-muted-foreground">Waiting for you in {call.targetName}’s chat.</p>}
        {onOpenTarget && <Button type="button" variant="secondary" size="sm" disabled={!active || action !== null} onClick={() => { void open() }}>
            {action === 'open' ? 'Opening chat…' : 'Open chat'}
        </Button>}
        {(openError || stopError) && <p role="alert" className="break-words text-xs text-destructive">{openError || stopError}</p>}
    </div>
}
