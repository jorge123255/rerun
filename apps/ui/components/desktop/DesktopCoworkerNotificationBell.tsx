'use client'

import { useEffect, useRef, useState } from 'react'
import { CoworkerBellMenu } from '@/components/notifications/settings/CoworkerBellMenu'
import { createNotificationSettingsText } from '@/components/notifications/settings/settings-copy'
import { desktopLocaleTag } from '@/lib/desktop/locale'
import { useDesktopLocale } from './DesktopLocale'
import { Button } from '@/components/ui/button'
import { isDesktopQuitting } from '@/lib/desktop/draft-writes'
import { DesktopNotificationsDialog } from './DesktopNotificationsDialog'
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
    const { language, t } = useDesktopLocale()
    const { prefs, setCoworkerRule, ruleOf, ready, readError, refresh } = useDesktopNotificationPrefs()
    const [scheduledCount, setScheduledCount] = useState(0)
    const [countUnavailable, setCountUnavailable] = useState(false)
    const alive = useRef(true)
    const owner = useRef(agentId); owner.current = agentId
    const countRead = useRef<AbortController | null>(null)
    useEffect(() => {
        alive.current = true
        setScheduledCount(0)
        setCountUnavailable(false)
        return () => { alive.current = false; countRead.current?.abort() }
    }, [agentId])

    const countScheduled = (isOpen: boolean) => {
        onOpenChange?.(isOpen)
        countRead.current?.abort()
        if (!isOpen || !ready || isDesktopQuitting()) return
        const controller = new AbortController()
        countRead.current = controller
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5000)])
        const current = () => alive.current && owner.current === agentId && countRead.current === controller && !signal.aborted && !isDesktopQuitting()
        setScheduledCount(0)
        setCountUnavailable(false)
        fetch(`/api/desktop/coworkers/${encodeURIComponent(agentId)}/schedules`, { cache: 'no-store', signal })
            .then(response => response.ok ? response.json() : Promise.reject(new Error('unreadable')))
            .then(list => { if (!Array.isArray(list)) throw new Error('unreadable'); if (current()) setScheduledCount(list.length) })
            .catch(() => { if (alive.current && owner.current === agentId && countRead.current === controller && !controller.signal.aborted && !isDesktopQuitting()) setCountUnavailable(true) })
    }

    return (
        <><CoworkerBellMenu
            name={name}
            rule={ruleOf(agentId)}
            scope={prefs.scope}
            t={createNotificationSettingsText(desktopLocaleTag(language.locale), language.messages.notificationSettings)}
            scheduledUnavailableHint={t('notificationUI.scheduledUnavailable')}
            scheduledCheckFailed={t('notificationUI.scheduledCheckFailed')}
            scheduledCount={scheduledCount}
            scheduledCountUnavailable={countUnavailable}
            disabled={!ready}
            onChange={(rule: CoworkerRule) => { if (ready && owner.current === agentId) setCoworkerRule(agentId, rule) }}
            onOpenSettings={onOpenSettings}
            open={open}
            onOpenChange={countScheduled}
            modal={modal}
            align={align}
            className={className}
        />{readError && <Button type="button" size="sm" variant="ghost" onClick={() => void refresh()}>{t('notificationUI.retryNotifications')}</Button>}</>
    )
}

/** The card owns its settings dialog, pinned to this coworker; opening it never creates a rule. */
export function DesktopCoworkerNotificationControl({ agentId, name }: { agentId: string; name: string }) {
    const [open, setOpen] = useState(false)
    return <><DesktopCoworkerNotificationBell key={agentId} agentId={agentId} name={name} onOpenSettings={() => setOpen(true)} />
        <DesktopNotificationsDialog open={open} onOpenChange={setOpen} pinnedCoworkerId={agentId} /></>
}
