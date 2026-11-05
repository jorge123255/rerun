'use client'

import { Badge, PANEL_CARD } from '@rerun/ui/primitives'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/ui/icon'
import { BellIcon, CheckCircle2Icon, LinkIcon, LogInIcon } from '@/lib/icons'
import { createDesktopServicesClient, type DesktopServiceDetails, type DesktopServicesClient } from '@/lib/desktop/services-client'
import { cn } from '@/lib/utils'

export function DesktopNotificationCard({ message }: { message: string }) {
    return (
        <div className={cn(PANEL_CARD, 'flex items-start gap-3 px-3 py-2.5')}>
            <Icon icon={BellIcon} size="sm" />
            <div className="min-w-0 flex-1">
                <p className="text-xs text-muted-foreground">Sent you a notification</p>
                <p className="mt-0.5 text-sm whitespace-pre-wrap text-foreground">{message}</p>
            </div>
            <Badge size="xs" tone="neutral" glow={false} className="mt-0.5">Read</Badge>
        </div>
    )
}

export function DesktopSetupCompleteCard({ agentName, summary, schedules, triggers }: {
    agentName?: string
    summary: string
    schedules: string[]
    triggers: string[]
}) {
    const activated = [
        schedules.length > 0 && `${schedules.length} schedule${schedules.length > 1 ? 's' : ''} on`,
        triggers.length > 0 && `${triggers.length} trigger${triggers.length > 1 ? 's' : ''} on`,
    ].filter((label): label is string => Boolean(label))
    return (
        <div className={cn(PANEL_CARD, 'flex flex-col gap-2 px-3 py-3')}>
            <div className="flex items-center gap-2 text-xs">
                <CheckCircle2Icon className="size-3.5 text-emerald-500" />
                <span className="font-medium text-foreground">{agentName ? `${agentName} is set up` : 'Setup complete'}</span>
            </div>
            {summary && <p className="text-sm text-foreground/90">{summary}</p>}
            {activated.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                    {activated.map(label => <Badge key={label} size="xs" tone="green" glow={false}>{label}</Badge>)}
                </div>
            )}
        </div>
    )
}

export function DesktopNeedsAuthCard({ agentId, slug, name, onOpenApps }: {
    agentId: string
    slug: string
    name: string
    onOpenApps: (input: { agentId: string; slug: string }) => Promise<void>
}) {
    const [client, setClient] = useState<DesktopServicesClient | null>(null)
    const [details, setDetails] = useState<DesktopServiceDetails | null>(null)
    const [connecting, setConnecting] = useState(false)
    const [error, setError] = useState('')
    const epoch = useRef(0)

    useEffect(() => {
        const next = createDesktopServicesClient(agentId)
        const current = ++epoch.current
        setClient(next)
        setDetails(null)
        setError('')
        return () => {
            if (epoch.current === current) epoch.current++
            next.dispose()
        }
    }, [agentId])

    useEffect(() => {
        if (!client) return
        const current = epoch.current
        let active = true
        void client.details(slug).then(result => {
            if (active && epoch.current === current) setDetails(result)
        }).catch(cause => {
            if (active && epoch.current === current) setError(cause instanceof Error ? cause.message : 'Could not load this app’s connection state.')
        })
        return () => { active = false }
    }, [client, slug])

    const pending = details?.installStatus === 'needs_auth'
    const done = details?.installStatus === 'active' && details.installed

    const connect = async () => {
        if (!client || connecting) return
        const current = epoch.current
        setConnecting(true)
        setError('')
        try {
            await onOpenApps({ agentId, slug })
            const result = await client.details(slug)
            if (epoch.current === current) setDetails(result)
        } catch (cause) {
            if (epoch.current === current) setError(cause instanceof Error ? cause.message : 'Could not open this app’s local setup.')
        } finally {
            if (epoch.current === current) setConnecting(false)
        }
    }

    return (
        <div className={cn(PANEL_CARD, 'flex flex-col gap-3 px-3 py-2.5')}>
            <div className="flex items-center gap-3">
                {details?.icon ? <Icon src={details.icon} size="sm" /> : <Icon icon={LinkIcon} size="sm" />}
                <div className="min-w-0 flex-1">
                    <p className="text-sm text-foreground">{name} added</p>
                    <p className="text-xs text-muted-foreground">{done ? 'Connected, the coworker can use it' : 'Sign in once so the coworker can use it'}</p>
                </div>
                {done && <Badge size="xs" tone="green" glow={false}>Connected</Badge>}
                {pending && (
                    <Button size="sm" variant="outline" disabled={connecting} onClick={() => void connect()}>
                        <LogInIcon />
                        {connecting ? 'Opening…' : 'Sign in'}
                    </Button>
                )}
            </div>
            {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        </div>
    )
}
