'use client'

import { BorderBeam } from '@rerun/ui'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/ui/icon'
import { Separator } from '@/components/ui/separator'
import { desktopMcpSignInAction, type DesktopMcpSignInAction } from '@/lib/desktop/mcp-sign-in-client'
import { humanizeToolSegment } from '@/lib/chat/connector-tools'
import { serviceIconProps } from '@/lib/services/icons'
import { cn } from '@/lib/utils'
import type { DesktopMcpSignInDecision, DesktopMcpSignInOAuthView, DesktopMcpSignInView } from '../../../../../packages/contracts/src/desktop-mcp-sign-in'
import { DesktopMcpSignInReceipt } from './DesktopMcpSignInReceipt'
import { DesktopMcpSignInStatusBadge } from './DesktopMcpSignInStatusBadge'
import { DesktopMcpDeviceSignIn } from './DesktopMcpDeviceSignIn'

export function DesktopMcpSignInBlock({ sessionId, request, active = true, inline, onAccepted, initialOAuth }: {
    sessionId: string
    request: DesktopMcpSignInView
    active?: boolean
    inline?: boolean
    initialOAuth?: DesktopMcpSignInOAuthView
    onAccepted?: (response: Response, stream: { signal: AbortSignal; cancelStream: () => void }) => void | Promise<void>
}) {
    const [view, setView] = useState(request)
    const [oauth, setOauth] = useState<DesktopMcpSignInOAuthView | undefined>(initialOAuth)
    const [pendingAction, setPendingAction] = useState<DesktopMcpSignInAction | null>(null)
    const [answered, setAnswered] = useState(false)
    const [deviceOpen, setDeviceOpen] = useState(false)
    const attempts = useRef(new Map<string, string>())
    const controller = useRef<AbortController | null>(null)
    const epoch = useRef(0)
    const mounted = useRef(true)
    const live = useRef({ owner: '', active })
    const actionLatch = useRef(false)
    const owner = `${sessionId}:${request.requestId}`
    live.current = { owner, active }

    useEffect(() => {
        mounted.current = true
        return () => { mounted.current = false; epoch.current++; controller.current?.abort() }
    }, [])
    useEffect(() => {
        epoch.current++
        controller.current?.abort()
        controller.current = null
        attempts.current.clear()
        actionLatch.current = false
        setView(request)
        setOauth(initialOAuth)
        setPendingAction(null)
        setAnswered(false)
        setDeviceOpen(false)
    }, [owner, active, request.revision, request.receipt?.accepted])

    const run = async (action: DesktopMcpSignInAction) => {
        if (!active || answered || pendingAction || actionLatch.current || sessionId !== view.source.sessionId) return
        const operation = action === 'decline' ? 'decline' : action === 'cancel' ? 'cancel' : 'connect'
        const attemptOperation = operation === 'cancel' ? 'connect' : operation
        const attemptId = action === 'recover' && view.receipt ? view.receipt.attemptId : attemptOperation === 'connect' && view.activeAttemptId ? view.activeAttemptId : attempts.current.get(attemptOperation) ?? crypto.randomUUID()
        attempts.current.set(attemptOperation, attemptId)
        actionLatch.current = true
        const actionOwner = owner
        const generation = ++epoch.current
        controller.current?.abort()
        const pending = new AbortController()
        controller.current = pending
        if (action !== 'status') setPendingAction(action)
        try {
            const result = await desktopMcpSignInAction(sessionId, action, {
                operation, requestId: view.requestId, attemptId, expectedRevision: view.revision, source: view.source,
            }, { signal: pending.signal })
            if (generation !== epoch.current || pending.signal.aborted || !mounted.current || !live.current.active || live.current.owner !== actionOwner) return
            if (result.kind === 'continuation') {
                setAnswered(true)
                controller.current = null
                await onAccepted?.(result.response, { signal: pending.signal, cancelStream: () => pending.abort() })
            } else {
                if (result.value.request) { setView(result.value.request); if (!result.value.request.activeAttemptId) attempts.current.delete('connect') }
                setOauth(result.value.oauth)
            }
        } catch {
            if (generation === epoch.current && !pending.signal.aborted && mounted.current) {
                if (action === 'complete' && oauth?.state === 'connected') {
                    setOauth({ ...oauth, message: 'Could not verify the server. Try Continue again.' })
                    return
                }
                setOauth({ state: 'error', message: 'Authorization failed. Retry.' })
                setView(current => current.receipt ? current : { ...current, status: 'error', error: 'Authorization failed. Retry.' })
            }
        } finally {
            if (generation === epoch.current) {
                controller.current = null
                actionLatch.current = false
                setPendingAction(null)
            }
        }
    }

    useEffect(() => {
        if (!active || oauth?.state !== 'waiting' || pendingAction || answered) return
        const timer = setTimeout(() => { void run('status') }, 1500)
        return () => clearTimeout(timer)
    }, [active, oauth?.state, pendingAction, answered, view])

    if (view.receipt) return <div className="flex flex-wrap items-center gap-2">
        <DesktopMcpSignInReceipt request={view} />
        {!view.receipt.accepted && <Button type="button" size="sm" variant="outline" disabled={!active || pendingAction !== null || answered} onClick={() => { void run('recover') }}>
            {pendingAction === 'recover' ? 'Retrying…' : 'Retry continuation'}
        </Button>}
    </div>
    const server = view.source.server
    const displayName = server.displayName || humanizeToolSegment(server.name)
    const subtitle = view.reason ?? (server.host ? `Custom MCP server · ${server.host}` : 'Custom MCP server')
    const busy = !active || pendingAction !== null || answered
    const connected = oauth?.state === 'connected'
    const waiting = oauth?.state === 'waiting'
    const canCancel = waiting || !!view.activeAttemptId
    const error = oauth?.message ?? view.error
    const deviceAvailable = (oauth?.deviceAvailable || initialOAuth?.deviceAvailable) && !canCancel && !connected

    return <div className={cn('relative space-y-3 overflow-hidden rounded-lg border border-border bg-muted/30 p-3', !inline && 'mb-2')}>
        <BorderBeam animated pattern="arcs" tone="brand" glow width={1} duration={7} />
        <div className="relative flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
            <Icon {...serviceIconProps(server.icon ?? null, 'custom')} size="sm" />
            <div className="min-w-32 flex-1">
                <span className="block truncate font-medium leading-snug">Sign in to {displayName}</span>
                <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
            </div>
            <DesktopMcpSignInStatusBadge request={view} oauth={oauth} />
            {(!deviceOpen || !active) && <div className="flex items-center gap-1">
                <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { void run('decline') }}>Not now</Button>
                {connected ? <Button type="button" size="sm" disabled={busy} onClick={() => { void run('complete') }}>Continue</Button>
                    : canCancel ? <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { void run('cancel') }} className="text-muted-foreground">Cancel</Button>
                        : <Button type="button" size="sm" disabled={busy} onClick={() => { void run('connect') }}>Connect</Button>}
                {deviceAvailable && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setDeviceOpen(true)}>Use a device code</Button>}
            </div>}
        </div>
        {(waiting || error) && <>
            <Separator className="-mx-3 border-t border-dashed bg-transparent data-horizontal:h-0 data-horizontal:w-auto" />
            <div className="space-y-2 py-1">
                {waiting && <>
                    <Button type="button" variant="outline" size="sm" className="w-full" disabled>Waiting for authorization…</Button>
                    {oauth?.authorizationUrl && <a className="inline-flex break-words text-sm text-muted-foreground underline underline-offset-2" href={oauth.authorizationUrl} target="_blank" rel="noreferrer">Open authorization in browser</a>}
                </>}
                {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
            </div>
        </>}
        {deviceOpen && active && deviceAvailable && <DesktopMcpDeviceSignIn key={owner} source={view.source} onBack={() => setDeviceOpen(false)}
            onConnected={() => { setDeviceOpen(false); setOauth({ state: 'connected' }) }} />}
    </div>
}
