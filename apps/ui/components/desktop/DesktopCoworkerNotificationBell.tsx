'use client'

import { useEffect, useRef, useState } from 'react'
import { CoworkerBellMenu } from '@/components/notifications/settings/CoworkerBellMenu'
import { useDesktopNotificationPrefs } from '@/lib/desktop/use-notification-prefs'
import type { CoworkerRule } from '@rerun/contracts'

// The coworker bell on desktop: the original menu verbatim, backed by the local preferences
// store. The scheduled count comes from this Mac's own schedules list, fetched lazily on open
// like the original fetches triggers; desktop has no trigger surface, so schedules are the count.
export function DesktopCoworkerNotificationBell({ agentId, name, onOpenSettings, open, onOpenChange, modal, align = 'end', className }: {
    agentId: string
    name: string
    onOpenSettings: () => void
    open?: boolean
    onOpenChange?: (open: boolean) => void
    modal?: boolean
    align?: 'start' | 'end'
    className?: string
}) {
    const { prefs, setCoworkerRule, ruleOf } = useDesktopNotificationPrefs()
    const [scheduledCount, setScheduledCount] = useState(0)
    const alive = useRef(true)
    useEffect(() => () => { alive.current = false }, [])

    const countScheduled = (isOpen: boolean) => {
        onOpenChange?.(isOpen)
        if (!isOpen) return
        fetch(`/api/desktop/coworkers/${encodeURIComponent(agentId)}/schedules`, { cache: 'no-store' })
            .then(response => response.ok ? response.json() : Promise.reject(new Error('unreadable')))
            .then(list => { if (alive.current && Array.isArray(list)) setScheduledCount(list.length) })
            .catch(() => {})
    }

    return (
        <CoworkerBellMenu
            name={name}
            rule={ruleOf(agentId)}
            scope={prefs.scope}
            scheduledCount={scheduledCount}
            onChange={(rule: CoworkerRule) => setCoworkerRule(agentId, rule)}
            onOpenSettings={onOpenSettings}
            open={open}
            onOpenChange={countScheduled}
            modal={modal}
            align={align}
            className={className}
        />
    )
}
