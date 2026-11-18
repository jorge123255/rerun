import { Fragment } from 'react'
import { Alert, View } from 'react-native'
import { useTranslations } from 'use-intl'

import { AppText } from '@/components/ui/AppText'
import { CheckRow, Section, Separator, SettingsRow, SwitchRow } from '@/components/ui/GroupedList'
import { Switch } from '@/components/ui/Switch'
import { spacing } from '@/theme/tokens'

import type { SettingsProps } from './MacCoworkerSettingsScreen'

export function MacCoworkerModel({ value, disabled, save }: SettingsProps) {
    const t = useTranslations('mobileCoworker.mac')
    const { coworker, effective, catalog } = value.model
    const { connectionId, model, reasoning, reasoningOptions } = effective
    function effort(next: string | null) {
        if (connectionId && model) save({ field: 'effort', body: { connectionId, model, effort: next } })
    }
    return <>
        <Section>
            <CheckRow label={t('follow')} detail={coworker ? undefined : effective.label} checked={!coworker} disabled={disabled || !coworker} onPress={() => save({ field: 'model', body: { action: 'follow-workspace' } })} />
            {!effective.available && <SettingsRow label={t('unavailable')} value={effective.label} />}
        </Section>
        {reasoningOptions?.length && effective.available && model && connectionId ? (
            <Section title={t('effort')}>
                <AppText variant="footnote" tone="muted" style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.md }}>{t('effortScope')}</AppText>
                <CheckRow label={t('defaultEffort')} detail={reasoning?.source !== 'model' ? reasoning?.effort : undefined} checked={reasoning?.source !== 'model'} disabled={disabled} onPress={() => effort(null)} />
                {reasoningOptions.map(option => <CheckRow key={option} label={option} checked={reasoning?.source === 'model' && reasoning.effort === option} disabled={disabled} onPress={() => effort(option)} />)}
            </Section>
        ) : null}
        {catalog.map(connection => <Section key={connection.connectionId} title={connection.name}>
            {connection.models.map(choice => <CheckRow key={choice.id} label={choice.label}
                checked={coworker?.connectionId === connection.connectionId && coworker.model === choice.id}
                disabled={disabled} onPress={() => save({ field: 'model', body: { action: 'coworker', model: choice.id, connectionId: connection.connectionId } })} />)}
        </Section>)}
    </>
}

export function MacCoworkerTools({ value, disabled, save, group }: SettingsProps & { group: 'rerun' | 'codex' }) {
    const t = useTranslations('mobileCoworker.mac')
    const common = useTranslations('mobileCommon')
    const rows = value.tools[group]
    return <Section>
        {rows.map((row, index) => {
            const locked = disabled || !row.available && !row.enabled
            const toggle = (enabled: boolean) => {
                if (locked) return
                const submit = () => save({ field: 'tools', body: { group, id: row.id, enabled } })
                if (enabled && row.confirmOnEnable) {
                    Alert.alert(t('confirm', { tool: row.label }), row.description, [
                        { text: common('actions.cancel'), style: 'cancel' },
                        { text: t('allow'), onPress: submit },
                    ])
                } else submit()
            }
            return <Fragment key={row.id}>
                {index > 0 && <Separator />}
                <View style={{ flexDirection: 'row', alignItems: 'center', padding: spacing.lg, gap: spacing.md }}>
                    <View style={{ flex: 1, gap: spacing.xs }}>
                        <AppText medium>{row.label}</AppText>
                        <AppText tone="muted" variant="footnote">{row.description}</AppText>
                        {row.unavailableReason && <AppText tone="muted" variant="footnote">{row.unavailableReason}</AppText>}
                    </View>
                    <Switch accessibilityLabel={row.label} disabled={locked} value={row.enabled} onValueChange={toggle} />
                </View>
            </Fragment>
        })}
    </Section>
}

export function MacCoworkerTargets({ value, disabled, save }: SettingsProps) {
    const t = useTranslations('mobileCoworker.mac')
    const { targets, allowedTargetIds } = value.callTargets
    const canCall = value.tools.rerun.some(row => row.id === 'callAgent' && row.enabled && row.available)
    return <>
        {!canCall && <AppText variant="footnote" tone="muted">{t('callOff')}</AppText>}
        {!targets.length && <AppText variant="footnote" tone="muted">{t('noTargets')}</AppText>}
        <Section>
            {targets.map(target => {
                const allowed = allowedTargetIds.includes(target.agentId)
                return <SwitchRow key={target.agentId} label={target.name} value={allowed} disabled={disabled || !canCall || !target.enabled && !allowed}
                    onValueChange={on => save({ field: 'call-targets', body: {
                        expectedTargetAgentIds: allowedTargetIds,
                        targetAgentIds: on ? [...allowedTargetIds, target.agentId] : allowedTargetIds.filter(id => id !== target.agentId),
                    } })} />
            })}
        </Section>
    </>
}
