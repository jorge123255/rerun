'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Switch } from '@/components/ui/switch'
import { useDesktopLocale } from './DesktopLocale'
import { DesktopQuickAskSettings } from './DesktopQuickAskSettings'
import { desktopMacUpdates, type MacUpdateState } from './DesktopMacUpdateBridge'

type MacSettings = { openAtLogin: boolean | null; version: string | null; updatesAvailable: boolean }
type MacSettingsBridge = {
    read: () => Promise<MacSettings>
    openPhonePairing?: () => Promise<void>
    setOpenAtLogin: (enabled: boolean) => Promise<MacSettings>
}
const updateMessages = {
    checking: 'macSettings.checking',
    downloading: 'macSettings.downloading',
    ready: 'macSettings.ready',
    error: 'macSettings.updateFailed',
} as const

export function desktopMacSettings() {
    if (typeof window === 'undefined') return undefined
    return (window as Window & { desktopApp?: { macSettings?: MacSettingsBridge } }).desktopApp?.macSettings
}

export function DesktopMacSettings({ appStoreBuild }: { appStoreBuild: boolean }) {
    const { t } = useDesktopLocale()
    const settingsBridge = desktopMacSettings()
    const openPhonePairing = settingsBridge?.openPhonePairing
    const updates = appStoreBuild ? null : desktopMacUpdates()
    const [settings, setSettings] = useState<MacSettings | null>(null)
    const [update, setUpdate] = useState<MacUpdateState | null>(null)
    const [loginBusy, setLoginBusy] = useState(false)
    const [updateBusy, setUpdateBusy] = useState(false)
    const [pairingError, setPairingError] = useState(false)
    const [settingsError, setSettingsError] = useState<'loadFailed' | 'loginFailed' | null>(null)
    const [updateError, setUpdateError] = useState<'updateFailed' | 'restartFailed' | null>(null)

    useEffect(() => {
        if (!settingsBridge) return
        let live = true
        void settingsBridge.read().then(value => { if (live) setSettings(value) },
            () => { if (live) setSettingsError('loadFailed') })
        return () => { live = false }
    }, [settingsBridge])

    useEffect(() => {
        if (!updates || !settings?.updatesAvailable) return
        let live = true
        let received = false
        const stop = updates.onState(value => {
            received = true
            if (live) setUpdate(value)
        })
        void updates.getState().then(value => { if (live && !received) setUpdate(value) }, () => {
            if (live && !received) setUpdate({ status: 'error' })
        })
        return () => { live = false; stop() }
    }, [updates, settings?.updatesAvailable])

    async function changeLogin(enabled: boolean) {
        if (!settingsBridge || loginBusy) return
        setLoginBusy(true)
        setSettingsError(null)
        try {
            const next = await settingsBridge.setOpenAtLogin(enabled)
            setSettings(next)
            if (next.openAtLogin !== enabled) setSettingsError('loginFailed')
        } catch { setSettingsError('loginFailed') }
        finally { setLoginBusy(false) }
    }

    async function runUpdate() {
        if (!updates || !settings?.updatesAvailable || updateBusy) return
        setUpdateBusy(true)
        setUpdateError(null)
        try {
            if (update?.status === 'ready') {
                if (!await updates.install()) setUpdateError('restartFailed')
            } else await updates.check()
        } catch { setUpdateError(update?.status === 'ready' ? 'restartFailed' : 'updateFailed') }
        finally { setUpdateBusy(false) }
    }

    const openAtLogin = settings?.openAtLogin ?? null
    const updateAvailable = Boolean(updates && settings?.updatesAvailable)
    const updateMessage = updateAvailable && update && update.status !== 'idle'
        ? t(updateMessages[update.status])
        : null
    const status = appStoreBuild ? t('macSettings.appStore')
        : settings && !updateAvailable ? t('macSettings.updatesUnavailable') : updateMessage

    return <div className="space-y-4">
        <div className="space-y-2 rounded-xl border p-4">
            <Field orientation="row" label={t('macSettings.login')}
                helperText={settings && openAtLogin === null ? t('macSettings.loginUnavailable') : t('macSettings.loginHint')}
                htmlFor="desktop-open-at-login">
                <Switch id="desktop-open-at-login" checked={openAtLogin === true}
                    disabled={openAtLogin === null || loginBusy} onCheckedChange={changeLogin} />
            </Field>
            {settingsError && <p role="alert" className="text-sm text-destructive">{t(`macSettings.${settingsError}`)}</p>}
        </div>
        <DesktopQuickAskSettings />
        {openPhonePairing && <div className="space-y-2 rounded-xl border p-4">
            <Field orientation="row" label={t('macSettings.phone')} helperText={t('macSettings.phoneHint')}>
                <Button type="button" size="sm" variant="outline" onClick={async () => {
                    setPairingError(false)
                    try { await openPhonePairing() }
                    catch { setPairingError(true) }
                }}>{t('macSettings.connectPhone')}</Button>
            </Field>
            {pairingError && <p role="alert" className="text-sm text-destructive">{t('macSettings.phoneFailed')}</p>}
        </div>}
        <div className="space-y-2 rounded-xl border p-4">
            <Field orientation="row" label={t('macSettings.updates')}
                helperText={settings?.version ? t('macSettings.version', { version: settings.version }) : undefined}>
                {updateAvailable && <Button size="sm" variant="outline" onClick={runUpdate}
                    disabled={updateBusy || !update || update.status === 'checking' || update.status === 'downloading'}>
                    {t(update?.status === 'ready' ? 'macSettings.restart' : 'macSettings.check')}
                </Button>}
            </Field>
            {status && <p role="status" className="text-xs text-muted-foreground">{status}</p>}
            {updateError && <p role="alert" className="text-sm text-destructive">{t(`macSettings.${updateError}`)}</p>}
        </div>
    </div>
}
