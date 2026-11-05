'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { CoworkerRules, type CoworkerPickerProps } from '@/components/notifications/settings/CoworkerRules'
import { ScopeRadioList } from '@/components/notifications/settings/ScopeRadioList'
import { SETTINGS_CARD, SettingsSection, SwitchRow } from '@/components/notifications/settings/SettingsSection'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Bell, Play, Volume2 } from '@/lib/icons'
import { playNotificationSound } from '@/lib/notifications/browser'
import { DESKTOP_NOTIFICATION_PREFS_URL, desktopNotificationPrefsPatchSchema } from '@/lib/desktop/notifications'
import { mergeNotificationPrefs, normalizeNotificationPrefs, type CoworkerRule, type NotificationPrefs, type NotificationPrefsPatch } from '@rerun/contracts'

// The original settings composition, reduced to the channels the Mac carries: the scope radio
// list, the in-app toast and sound rows (hosted email stays out of the surface and out of
// delivery), and the per-coworker rules, stored durably on this Mac.

type DesktopCoworker = { id: string; name: string }

// The bell's picker is the coworker combobox upstream; the desktop path avoids the hosted board
// store and picks from the local roster with the same wording.
function DesktopCoworkerPicker({ coworkers, exclude, onPick, disabled }: CoworkerPickerProps & { coworkers: readonly DesktopCoworker[]; disabled?: boolean }) {
    const available = coworkers.filter(coworker => !exclude.includes(coworker.id))
    return (
        <Select value="" onValueChange={value => { if (value) onPick(value) }}>
            <SelectTrigger size="sm" className="w-full" aria-label="Choose a coworker" disabled={disabled || available.length === 0}>
                <SelectValue placeholder="Choose a coworker" />
            </SelectTrigger>
            <SelectContent>
                {available.map(coworker => <SelectItem key={coworker.id} value={coworker.id}>{coworker.name}</SelectItem>)}
            </SelectContent>
        </Select>
    )
}

function DesktopNotificationChannels({ prefs, onChange }: { prefs: NotificationPrefs; onChange: (patch: Partial<Pick<NotificationPrefs, 'toast' | 'sound'>>) => void }) {
    const silent = prefs.scope === 'nothing'
    return (
        <SettingsSection title="How">
            <div className={SETTINGS_CARD}>
                <SwitchRow icon={Bell} label="Toast in the app" description="Shows a desktop notification while Rerun is open." checked={prefs.toast} disabled={silent} onChange={toast => onChange({ toast })} />
                <SwitchRow
                    icon={Volume2}
                    label="Sound"
                    description="Only when a coworker needs you or something breaks."
                    checked={prefs.sound}
                    disabled={silent}
                    onChange={sound => onChange({ sound })}
                    extra={
                        <Button type="button" variant="ghost" size="icon-sm" aria-label="Play notification sound" disabled={silent} onClick={() => playNotificationSound()} className="text-muted-foreground hover:text-foreground">
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
export function DesktopNotificationSettings() {
    const [prefs, setPrefs] = useState<NotificationPrefs | null>(null)
    const [coworkers, setCoworkers] = useState<DesktopCoworker[]>([])
    const [readFailed, setReadFailed] = useState(false)
    const [attempt, setAttempt] = useState(0)
    const [error, setError] = useState('')
    const saving = useRef<Promise<unknown>>(Promise.resolve())
    const mounted = useRef(true)

    useEffect(() => {
        mounted.current = true
        return () => { mounted.current = false }
    }, [])

    const load = useCallback(async () => {
        try {
            const [prefsResponse, agentsResponse] = await Promise.all([
                fetch(DESKTOP_NOTIFICATION_PREFS_URL, { cache: 'no-store' }),
                fetch('/api/desktop/agents', { cache: 'no-store' }),
            ])
            if (!prefsResponse.ok || !agentsResponse.ok) throw new Error('Could not load the notification settings. Try again.')
            const agents = normalizeCoworkers(await agentsResponse.json())
            if (!mounted.current) return
            setCoworkers(agents)
            setPrefs(normalizeNotificationPrefs(await prefsResponse.json()))
            setReadFailed(false)
        } catch {
            if (mounted.current) setReadFailed(true)
        }
    }, [])

    useEffect(() => { if (attempt > 0) void load() }, [attempt, load])
    useEffect(() => { void load() }, [load])

    // One write at a time, exactly like the original's settings queue: two quick changes must not
    // clobber each other, and the authoritative merged value replaces the optimistic one.
    const update = useCallback((patch: NotificationPrefsPatch) => {
        const parsed = desktopNotificationPrefsPatchSchema.safeParse(patch)
        if (!parsed.success) { setError('Choose a valid notification scope, channel or coworker rule.'); return }
        setPrefs(current => current ? mergeNotificationPrefs(current, parsed.data) : current)
        setError('')
        saving.current = saving.current
            .then(async () => {
                const response = await fetch(DESKTOP_NOTIFICATION_PREFS_URL, {
                    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(parsed.data), cache: 'no-store',
                })
                if (!response.ok) throw new Error('Could not save your notification settings. Try again.')
                if (!mounted.current) return
                setPrefs(normalizeNotificationPrefs(await response.json()))
            })
            .catch(cause => { if (mounted.current) setError(cause instanceof Error ? cause.message : 'Could not save your notification settings. Try again.') })
    }, [])

    const setCoworkerRule = useCallback((agentId: string, rule: CoworkerRule) => update({ coworkers: { [agentId]: rule } }), [update])

    if (readFailed) {
        return (
            <div className="space-y-2">
                <div role="alert" className="space-y-2 text-sm text-destructive">
                    <p>Could not load your notification settings. Try again.</p>
                    <Button type="button" variant="outline" size="sm" onClick={() => setAttempt(value => value + 1)}>Retry</Button>
                </div>
            </div>
        )
    }
    if (!prefs) return <p role="status" className="text-sm text-muted-foreground">Loading your notification settings…</p>

    return (
        <div className="flex flex-col gap-6">
            <ScopeRadioList scope={prefs.scope} onChange={scope => update({ scope })} />
            <DesktopNotificationChannels prefs={prefs} onChange={update} />
            <CoworkerRules coworkers={coworkers} rules={prefs.coworkers} onChange={setCoworkerRule}
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
