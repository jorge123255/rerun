'use client'

import { useEffect, useState } from 'react'
import { Switch } from '@/components/ui/switch'
import { useDesktopLocale } from './DesktopLocale'

type ShortcutState = { enabled: boolean; registered: boolean }
type ShortcutBridge = { read: () => Promise<ShortcutState>; set: (enabled: boolean) => Promise<ShortcutState> }

export function DesktopQuickAskSettings() {
    const { t } = useDesktopLocale()
    const [bridge, setBridge] = useState<ShortcutBridge | null>(null)
    const [state, setState] = useState<ShortcutState | null>(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState(false)
    useEffect(() => {
        const native = (window as Window & { desktopApp?: { quickAskSettings?: ShortcutBridge } }).desktopApp?.quickAskSettings
        if (!native) return
        setBridge(native)
        let active = true
        void native.read().then(value => { if (active) setState(value) }, () => { if (active) setError(true) })
        return () => { active = false }
    }, [])
    if (!bridge) return null
    async function change(enabled: boolean) {
        if (!bridge || busy) return
        setBusy(true)
        setError(false)
        try { setState(await bridge.set(enabled)) }
        catch { setError(true) }
        finally { setBusy(false) }
    }
    return <div className="flex items-center justify-between gap-4 rounded-xl border p-4">
        <div>
            <label className="text-sm font-medium" htmlFor="desktop-quick-ask-shortcut">{t('foreman.quickAskShortcut')}</label>
            <p className="text-sm text-muted-foreground">{t('foreman.quickAskShortcutHint')}</p>
            {error ? <p role="alert" className="text-sm text-destructive">{t('foreman.quickAskShortcutError')}</p>
                : state?.enabled && !state.registered && <p role="status" className="text-sm text-muted-foreground">{t('foreman.quickAskShortcutUnavailable')}</p>}
        </div>
        <Switch id="desktop-quick-ask-shortcut" checked={state?.enabled ?? false} disabled={!state || busy} onCheckedChange={change} />
    </div>
}
