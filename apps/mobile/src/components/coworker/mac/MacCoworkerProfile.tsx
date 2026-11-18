import { randomUUID } from 'expo-crypto'
import { useState } from 'react'
import { View } from 'react-native'
import { useTranslations } from 'use-intl'

import { Button } from '@/components/ui/Button'
import { CheckRow, Section, SettingsRow, SwitchRow } from '@/components/ui/GroupedList'
import { TextField } from '@/components/ui/TextField'
import { spacing } from '@/theme/tokens'

import type { SettingsProps } from './MacCoworkerSettingsScreen'

type Field = { label: string; id: string; initial: string; save: (value: string) => void; disabled: boolean; multiline?: boolean; verbatim?: boolean; maxLength?: number; required?: boolean }

function EditableText({ label, id, initial, disabled, multiline, verbatim, maxLength, required, save }: Field) {
    const [draft, setDraft] = useState(initial)
    const t = useTranslations('mobileCoworker.details')
    return <View style={{ gap: spacing.sm }}>
        <TextField id={id} label={label} value={draft} multiline={multiline} onChangeText={setDraft} verbatim={verbatim} maxLength={maxLength} disabled={disabled} />
        {draft !== initial && <Button label={t('save')} size="sm" disabled={disabled || (required && !draft.trim())} onPress={() => save(draft.trim())} />}
    </View>
}

export function MacCoworkerProfile({ value, save, disabled }: SettingsProps) {
    const t = useTranslations('mobileCoworker.mac')
    const details = useTranslations('mobileCoworker.create')
    const { settings, board } = value
    return <>
        <EditableText key={'name:' + value.name} id="coworker-name" label={details('nameLabel')} initial={value.name} maxLength={60} disabled={disabled} required save={name => save({ field: 'name', body: { name } })} />
        <EditableText key={'description:' + value.description} id="coworker-description" label={t('description')} initial={value.description} maxLength={2000} multiline disabled={disabled} save={description => save({ field: 'settings', body: { description } })} />
        <EditableText key={'soul:' + settings.soul} id="coworker-instructions" label={t('instructions')} initial={settings.soul} maxLength={100_000} multiline disabled={disabled || !settings.soulEditable} required save={soul => save({ field: 'settings', body: { soul } })} />
        <EditableText key={'repo:' + settings.repository} id="coworker-repository" label={t('repository')} initial={settings.repository ?? ''} verbatim disabled={disabled} maxLength={300} save={repository => save({ field: 'settings', body: { repository: repository || null } })} />
        <Section title={details('boxLabel')}>
            {board.spaces.map(space => <CheckRow key={space.id} label={space.name} checked={board.spaceId === space.id} disabled={disabled || space.id === board.spaceId}
                onPress={() => save({ field: 'box', body: { spaceId: space.id, requestId: randomUUID(), expectedRevision: board.revision } })} />)}
        </Section>
        <Section title={t('replyLength')}>
            {(['minimal', 'concise', 'normal', 'detailed'] as const).map(verbosity => <CheckRow key={verbosity} label={t(verbosity)} checked={settings.verbosity === verbosity} disabled={disabled}
                onPress={() => save({ field: 'settings', body: { verbosity } })} />)}
        </Section>
        <Section>
            <SwitchRow label={t('suggestedReplies')} value={settings.suggestedReplies} disabled={disabled} onValueChange={suggestedReplies => save({ field: 'settings', body: { suggestedReplies } })} />
            <SwitchRow label={t('memory')} value={settings.memoryEnabled} disabled={disabled} onValueChange={memoryEnabled => save({ field: 'settings', body: { memoryEnabled } })} />
            <SwitchRow label={t('learn')} value={settings.autoMemory && settings.memoryEnabled && settings.selfImprovementEnabled} disabled={disabled || !settings.memoryEnabled || !settings.selfImprovementEnabled} onValueChange={autoMemory => save({ field: 'settings', body: { autoMemory } })} />
        </Section>
    </>
}

export function MacCoworkerSetup({ value, disabled, save, onOpen }: SettingsProps & { onOpen: (sessionId: string) => void }) {
    const t = useTranslations('mobileCoworker.mac')
    const { setup } = value
    const change = (action: 'start' | 'continue' | 'skip') => save({ field: 'setup', body: { action, expectedRevision: setup.revision, requestId: randomUUID() } })
    return <Section title={t('setup')}>
        <SettingsRow label={t('status')} value={t(setup.completedAt ? 'complete' : setup.skipped ? 'skipped' : setup.sessionId || setup.canContinue ? 'setupInProgress' : setup.required === true ? 'pending' : 'optional')} />
        {!!setup.sessionId && !setup.skipped && <SettingsRow label={t(setup.completedAt ? 'setupChat' : 'continue')} onPress={() => { if (setup.sessionId) onOpen(setup.sessionId) }} />}
        {setup.canContinue && (!setup.sessionId || setup.skipped) && <SettingsRow label={t('continue')} onPress={() => change('continue')} disabled={disabled || !value.enabled} />}
        {setup.canStart && !setup.canContinue && !setup.sessionId && <SettingsRow label={t('start')} onPress={() => change('start')} disabled={disabled || !value.enabled} />}
        {setup.canSkip && <SettingsRow label={t('skip')} onPress={() => change('skip')} disabled={disabled} />}
    </Section>
}
