'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { CoworkerRules, type CoworkerPickerProps } from '@/components/notifications/settings/CoworkerRules'
import { useDesktopLocale } from './DesktopLocale'
import { desktopLocaleTag } from '@/lib/desktop/locale'
import { createNotificationSettingsText } from '@/components/notifications/settings/settings-copy'
import { ScopeRadioList } from '@/components/notifications/settings/ScopeRadioList'
import { SETTINGS_CARD, SettingsSection, SwitchRow } from '@/components/notifications/settings/SettingsSection'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Bell, Play, Volume2 } from '@/lib/icons'
import { playNotificationSound } from '@/lib/notifications/browser'
import { useDesktopNotificationPrefs } from '@/lib/desktop/use-notification-prefs'
import { isDesktopQuitting } from '@/lib/desktop/draft-writes'
import type { NotificationPrefs } from '@rerun/contracts'

// The original settings composition, reduced to the channels the Mac carries: the scope radio
// list, the in-app toast and sound rows (hosted email stays out of the surface and out of
// delivery), and the per-coworker rules, stored durably on this Mac.

type DesktopCoworker = { id: string; name: string }

// The bell's picker is the coworker combobox upstream; the desktop path avoids the hosted board
// store and picks from the local roster with the same wording.
function DesktopCoworkerPicker({ coworkers, exclude, onPick, disabled }: CoworkerPickerProps & { coworkers: readonly DesktopCoworker[]; disabled?: boolean }) {
    const { t } = useDesktopLocale()
    const available = coworkers.filter(coworker => !exclude.includes(coworker.id))
    return (
        <Select value="" onValueChange={value => { if (value) onPick(value) }}>
            <SelectTrigger size="sm" className="w-full" aria-label={t('notificationUI.choose')} disabled={disabled || available.length === 0}>
                <SelectValue placeholder={t('notificationUI.choose')} />
            </SelectTrigger>
            <SelectContent>
                {available.map(coworker => <SelectItem key={coworker.id} value={coworker.id}>{coworker.name}</SelectItem>)}
            </SelectContent>
        </Select>
    )
}

function DesktopNotificationChannels({ prefs, onChange }: { prefs: NotificationPrefs; onChange: (patch: Partial<Pick<NotificationPrefs, 'toast' | 'sound'>>) => void }) {
    const { t } = useDesktopLocale()
    const silent = prefs.scope === 'nothing'
    return (
        <SettingsSection title={t('notificationSettings.channels.title')}>
            <div className={SETTINGS_CARD}>
                <SwitchRow icon={Bell} label={t('notificationUI.desktop')} description={t('notificationUI.desktopDescription')} checked={prefs.toast} disabled={silent} onChange={toast => onChange({ toast })} />
                <SwitchRow
                    icon={Volume2}
                    label={t('notificationSettings.channels.sound.label')}
                    description={t('notificationSettings.channels.sound.description')}
                    checked={prefs.sound}
                    disabled={silent}
                    onChange={sound => onChange({ sound })}
                    extra={
                        <Button type="button" variant="ghost" size="icon-sm" aria-label={t('notificationSettings.channels.sound.play')} disabled={silent} onClick={() => playNotificationSound()} className="text-muted-foreground hover:text-foreground">
                            <Play />
                        </Button>
                    }
                />
            </div>
        </SettingsSection>
    )
}

// Hosted email and cloud push never leave the Mac: the original email rows and the account-emails
// tab have no local channel to configure, so the settings surface carries nothing for them.
export function DesktopNotificationSettings({ pinnedCoworkerId }: { pinnedCoworkerId?: string | null }) {
    const { language, t } = useDesktopLocale()
    const settingsText = createNotificationSettingsText(desktopLocaleTag(language.locale), language.messages.notificationSettings)
    const { prefs, ready, readError: prefsReadError, saveError: error, update, setCoworkerRule, refresh } = useDesktopNotificationPrefs()
    const [coworkers, setCoworkers] = useState<DesktopCoworker[]>([])
    const [rosterReady, setRosterReady] = useState(false)
    const [readFailed, setReadFailed] = useState(false)
    const [attempt, setAttempt] = useState(0)
    const mounted = useRef(true)
    const read = useRef<AbortController | null>(null)

    useEffect(() => {
        mounted.current = true
        return () => { mounted.current = false; read.current?.abort() }
    }, [])

    const load = useCallback(async () => {
        read.current?.abort()
        const controller = new AbortController()
        read.current = controller
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)])
        const current = () => mounted.current && read.current === controller && !signal.aborted && !isDesktopQuitting()
        try {
            const agentsResponse = await fetch('/api/desktop/agents', { cache: 'no-store', signal })
            if (!agentsResponse.ok) throw new Error('Could not load the notification settings. Try again.')
            const agents = normalizeCoworkers(await agentsResponse.json())
            if (!current()) return
            setCoworkers(agents)
            setRosterReady(true)
            setReadFailed(false)
        } catch {
            if (mounted.current && read.current === controller && !controller.signal.aborted && !isDesktopQuitting()) setReadFailed(true)
        }
    }, [])

    useEffect(() => { if (attempt > 0) void load() }, [attempt, load])
    useEffect(() => { void load() }, [load])

    if (readFailed || prefsReadError) {
        return (
            <div className="space-y-2">
                <div role="alert" className="space-y-2 text-sm text-destructive">
                    <p>{t('notificationUI.loadFailed')}</p>
                    <Button type="button" variant="outline" size="sm" onClick={() => { setAttempt(value => value + 1); void refresh() }}>{t('actions.retry')}</Button>
                </div>
            </div>
        )
    }
    if (!ready || !rosterReady) return <p role="status" className="text-sm text-muted-foreground">{t('notificationUI.loading')}</p>

    if (pinnedCoworkerId && !coworkers.some(owner => owner.id === pinnedCoworkerId)) return <p role="alert" className="text-sm text-muted-foreground">{t('notificationUI.unavailable')}</p>

    return (
        <div className="flex flex-col gap-6">
            <ScopeRadioList t={settingsText} scope={prefs.scope} onChange={scope => update({ scope })} />
            <DesktopNotificationChannels prefs={prefs} onChange={update} />
            <CoworkerRules t={settingsText} coworkers={coworkers} rules={prefs.coworkers} pinnedId={pinnedCoworkerId} onChange={setCoworkerRule} detail={t('notificationUI.ruleDetail')}
                renderPicker={({ exclude, onPick }) => <DesktopCoworkerPicker coworkers={coworkers} exclude={exclude} onPick={onPick} />} />
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
    )
}

function normalizeCoworkers(value: unknown): DesktopCoworker[] {
    const agents = (value as { agents?: unknown })?.agents
    return Array.isArray(agents)
        ? agents.filter(item => !!item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string' && typeof (item as { name?: unknown }).name === 'string')
            .map(item => ({ id: String((item as { id: unknown }).id), name: String((item as { name: unknown }).name) }))
        : []
}
