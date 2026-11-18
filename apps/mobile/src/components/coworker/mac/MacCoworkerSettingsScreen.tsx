import type { MacPhoneCoworkerSettings, MacPhoneCoworkerSettingsChange } from '@rerun/mac-contracts/mac-phone-pairing'
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router'
import { useCallback, useRef, useState } from 'react'
import { ActivityIndicator, Alert, View } from 'react-native'
import { useTranslations } from 'use-intl'

import { CoworkerPage } from '@/components/coworker/CoworkerPage'
import { AppText } from '@/components/ui/AppText'
import { Button } from '@/components/ui/Button'
import { Section, SettingsRow, SwitchRow } from '@/components/ui/GroupedList'
import { translatorFor } from '@/i18n/translator'
import type { MacHub } from '@/mac/hub'
import { isDefiniteSettingsRefusal, isReceiptChange } from '@/mac/settings-retries'
import { spacing } from '@/theme/tokens'

import { MacCoworkerModel, MacCoworkerTools, MacCoworkerTargets } from './MacCoworkerCapabilities'
import { MacCoworkerProfile, MacCoworkerSetup } from './MacCoworkerProfile'

export type SettingsProps = { value: MacPhoneCoworkerSettings; disabled: boolean; save: (change: MacPhoneCoworkerSettingsChange) => void }
const sections = ['profile', 'model', 'rerun', 'codex', 'claude', 'targets', 'setup'] as const
type Page = (typeof sections)[number]
type SettingsHub = Pick<MacHub, 'readCoworkerSettings' | 'changeCoworkerSettings' | 'unconfirmedSettingsChange'>

export function MacCoworkerSettingsScreen({ hub }: { hub: SettingsHub }) {
    const { id, page } = useLocalSearchParams<{ id: string; page?: string }>()
    const selected = sections.find(name => name === page)
    return <>
        {/* On iOS 26, a rightward drag on the effort slider would otherwise start a full-screen Back gesture. Edge-swipe Back remains available. */}
        <Stack.Screen options={{ gestureResponseDistance: selected === 'model' ? { end: 28 } : undefined }} />
        <MacSettingsPage key={id} hub={hub} agentId={id} page={selected} />
    </>
}

function MacSettingsPage({ hub, agentId, page }: { hub: SettingsHub; agentId: string; page?: Page }) {
    const t = useTranslations('mobileCoworker.mac')
    const home = useTranslations('mobileHome')
    const [value, setValue] = useState<MacPhoneCoworkerSettings | null>(null)
    const [error, setError] = useState('')
    const [suspended, setSuspended] = useState(false)
    const [saving, setSaving] = useState(false)
    const [retry, setRetry] = useState(0)
    const [unconfirmed, setUnconfirmed] = useState<MacPhoneCoworkerSettingsChange | null>(null)
    const focus = useRef<AbortController | null>(null)
    const lock = useRef(false)
    const read = useCallback(async (signal: AbortSignal) => {
        const result = await hub.readCoworkerSettings(agentId, signal)
        if (result.agentId !== agentId) throw new Error('not_found')
        if (!signal.aborted) { setValue(result); setSuspended(false) }
    }, [agentId, hub])
    useFocusEffect(useCallback(() => {
        const controller = new AbortController()
        focus.current = controller
        lock.current = false
        setValue(null)
        setSaving(false)
        setError('')
        const field = page === 'setup' ? 'setup' : page === 'profile' ? 'box' : null
        setUnconfirmed(field ? hub.unconfirmedSettingsChange(agentId, field) : null)
        read(controller.signal).catch(reason => {
            if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : translatorFor('mobileCoworker')('mac.failed'))
        })
        return () => { controller.abort(); focus.current = null }
    }, [read, retry, page, hub, agentId]))
    async function save(change: MacPhoneCoworkerSettingsChange) {
        const signal = focus.current?.signal
        if (!signal || signal.aborted || lock.current || !value?.permissions.changeSettings || suspended) return
        lock.current = true
        setSaving(true)
        setError('')
        setUnconfirmed(null)
        let acknowledged = false
        try {
            await hub.changeCoworkerSettings(agentId, change, signal)
            acknowledged = true
            await read(signal)
        } catch (reason) {
            if (signal.aborted) return
            const detail = reason instanceof Error ? reason.message : t('failed')
            const message = detail === 'settings_not_allowed' ? t('readOnly') : detail
            if (!acknowledged && isReceiptChange(change) && !isDefiniteSettingsRefusal(reason)) setUnconfirmed(change)
            setError(message)
            Alert.alert(t('failed'), message)
            // Keep the Mac's actual settings authoritative after lost replies, revoked access or
            // conflicting edits. A failed reload leaves every write locked until a successful one.
            setSuspended(true)
            try { await read(signal) } catch { if (!signal.aborted) setValue(null) }
        } finally {
            if (!signal.aborted) { lock.current = false; setSaving(false) }
        }
    }
    const open = (section: Page) => router.push({ pathname: '/coworker/[id]', params: { id: agentId, page: section } })
    const disabled = saving || suspended || !value?.permissions.changeSettings
    const activePage = page === 'claude' && value && !value.tools.claude?.length ? undefined : page
    const title = activePage ? t(activePage) : value?.name ?? t('title')
    const settings = value && { value, disabled, save }
    return (
        <CoworkerPage title={title} onBack={() => router.back()}>
            {(!!error || !!unconfirmed) && <View accessibilityRole="alert" style={{ gap: spacing.sm }}>
                <AppText tone="destructive">{error || t('unconfirmed')}</AppText>
                <Button label={home('retry')} variant="secondary" size="sm" disabled={saving} onPress={() => {
                    if (unconfirmed && !disabled) void save(unconfirmed)
                    else setRetry(n => n + 1)
                }} />
            </View>}
            {!value && !error && <ActivityIndicator />}
            {value && !value.permissions.changeSettings && <View style={{ gap: spacing.sm }}>
                <AppText tone="muted" variant="footnote">{t('readOnly')}</AppText>
                <Button label={t('refresh')} variant="secondary" size="sm" onPress={() => setRetry(n => n + 1)} />
            </View>}
            {settings && value && (activePage === 'profile' ? <MacCoworkerProfile {...settings} />
                : activePage === 'model' ? <MacCoworkerModel {...settings} />
                : activePage === 'rerun' || activePage === 'codex' || activePage === 'claude' ? <MacCoworkerTools {...settings} group={activePage} />
                : activePage === 'targets' ? <MacCoworkerTargets {...settings} />
                : activePage === 'setup' ? <MacCoworkerSetup {...settings} />
                : <>
                    <Section title={t('title')}>
                        <SettingsRow label={t('profile')} value={value.board.spaces.find(space => space.id === value.board.spaceId)?.name} accessory="chevron" onPress={() => open('profile')} />
                        <SettingsRow label={t('model')} value={value.model.effective.label} accessory="chevron" onPress={() => open('model')} />
                        <SettingsRow label={t('rerun')} accessory="chevron" onPress={() => open('rerun')} />
                        {value.tools.codex.length > 0 && <SettingsRow label={t('codex')} accessory="chevron" onPress={() => open('codex')} />}
                        {Boolean(value.tools.claude?.length) && <SettingsRow label={t('claude')} accessory="chevron" onPress={() => open('claude')} />}
                        <SettingsRow label={t('targets')} accessory="chevron" onPress={() => open('targets')} />
                        <SettingsRow label={t('setup')} accessory="chevron" onPress={() => open('setup')} />
                        <SwitchRow label={t('enabled')} value={value.enabled} disabled={disabled} onValueChange={enabled => save({ field: 'enabled', body: { enabled } })} />
                    </Section>
                    <Section title={t('credentials')}>
                        {(['vault', 'providerSignIns', 'mcpSecrets', 'serviceAccounts'] as const).map(key =>
                            <SettingsRow key={key} label={t(key)} value={t('setOnMac')} />)}
                    </Section>
                </>)}
        </CoworkerPage>
    )
}
