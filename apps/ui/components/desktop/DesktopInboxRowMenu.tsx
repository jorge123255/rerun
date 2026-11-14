'use client'

import { useEffect, useRef } from 'react'
import type { CoworkerRule } from '@rerun/contracts'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { BellOff, CalendarClock, EllipsisIcon, SettingsIcon } from '@/lib/icons'
import type { DesktopNotificationRuleChange } from '@/lib/desktop/notifications'
import { useDesktopLocale } from './DesktopLocale'

export function DesktopInboxRowMenu({ workspaceId, agentId, agentName, rule, ready, changeRule, onOpenSettings, onOpenChange }: {
    workspaceId: number
    agentId: string
    agentName: string
    rule: CoworkerRule
    ready: boolean
    changeRule: (input: DesktopNotificationRuleChange) => Promise<boolean>
    onOpenSettings: () => void
    onOpenChange: (open: boolean) => void
}) {
    const { t } = useDesktopLocale()
    const open = useRef(false)
    const saving = useRef(false)
    useEffect(() => () => { if (open.current) onOpenChange(false) }, [onOpenChange])

    const apply = async (input: DesktopNotificationRuleChange, message: string) => {
        if (saving.current) return
        saving.current = true
        const saved = await changeRule(input).finally(() => { saving.current = false })
        if (!saved) return
        // Undo compares only the changed field, leaving later edits to the other field intact.
        const restore: DesktopNotificationRuleChange = input.field === 'mode'
            ? { ...input, expected: input.value, value: input.expected }
            : { ...input, expected: input.value, value: input.expected }
        toast(message, { action: { label: t('notificationRowMenu.undo'), onClick: () => { void changeRule(restore) } } })
    }

    return (
        <span role="presentation" onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
            <DropdownMenu modal={false} onOpenChange={next => { open.current = next; onOpenChange(next) }}>
                <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label={t('notificationRowMenu.options')} className="text-muted-foreground">
                        <EllipsisIcon />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64">
                    {ready && rule.follow && (
                        <DropdownMenuItem onSelect={() => { void apply({ workspaceId, agentId, field: 'follow', expected: true, value: false }, t('notificationRowMenu.unfollowed', { name: agentName })) }}>
                            <CalendarClock />
                            {t('notificationRowMenu.unfollow')}
                        </DropdownMenuItem>
                    )}
                    {ready && rule.mode !== 'muted' && (
                        <DropdownMenuItem onSelect={() => { void apply({ workspaceId, agentId, field: 'mode', expected: rule.mode, value: 'muted' }, t('notificationRowMenu.muted', { name: agentName })) }}>
                            <BellOff />
                            <span className="truncate">{t('notificationRowMenu.mute', { name: agentName })}</span>
                        </DropdownMenuItem>
                    )}
                    {ready && (rule.follow || rule.mode !== 'muted') && <DropdownMenuSeparator />}
                    <DropdownMenuItem onSelect={onOpenSettings}>
                        <SettingsIcon />
                        {t('notificationRowMenu.settings')}
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </span>
    )
}
