'use client'

import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { MarkdownTextarea } from '@/components/ui/markdown-textarea'
import { Segmented } from '@/components/ui/segmented'
import { Wand2 } from '@/lib/icons'
import { useDesktopLocale } from '../DesktopLocale'

export type DesktopSetupDraft = { required: boolean | null; prompt: string }

export function DesktopSetupFields({ value, defaultPrompt, onChange, disabled }: {
    value: DesktopSetupDraft
    defaultPrompt: string
    onChange: (next: DesktopSetupDraft) => void
    disabled?: boolean
}) {
    const { t } = useDesktopLocale()
    const choices = [
        { value: 'yes', label: t('coworkerSetup.fields.yes') },
        { value: 'no', label: t('coworkerSetup.fields.no') },
    ]
    const prompt = value.prompt.trim()
    const isDefault = prompt === defaultPrompt.trim()
    const useDefaultTemplate = () => onChange({ ...value, prompt: defaultPrompt })

    const resetButton = (
        <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={prompt ? undefined : useDefaultTemplate} className="self-start">
            <Wand2 className="mr-1.5 size-3.5" />
            {prompt ? t('coworkerSetup.fields.resetToDefault') : t('coworkerSetup.fields.useDefault')}
        </Button>
    )

    return (
        <div className="flex flex-col gap-3">
            <Field label={t('coworkerSetup.fields.needsSetup.label')} helperText={t('coworkerSetup.author.answerHint')}>
                <Segmented
                    options={choices}
                    value={value.required === null ? '' : value.required ? 'yes' : 'no'}
                    onChange={next => {
                        const required = next === 'yes'
                        onChange({ required, prompt: required && !prompt ? defaultPrompt : value.prompt })
                    }}
                    className={disabled ? 'pointer-events-none opacity-60' : undefined}
                />
            </Field>

            {value.required === true && (
                <div className="flex flex-col gap-1.5">
                    <MarkdownTextarea
                        label={t('coworkerSetup.fields.instructions.label')}
                        helperText={t('coworkerSetup.fields.instructions.helper')}
                        dialogTitle={t('coworkerSetup.fields.instructions.dialogTitle')}
                        editorLabels={{ open: t('coworkerSetup.editor.openEditor'), done: t('coworkerSetup.editor.done') }}
                        disabled={disabled}
                        value={value.prompt}
                        onChange={prompt => onChange({ ...value, prompt })}
                        placeholder={defaultPrompt}
                        className="min-h-40 font-mono text-xs"
                    />
                    {!isDefault &&
                        (prompt ? (
                            <ConfirmDialog
                                title={t('coworkerSetup.fields.resetConfirm.title')}
                                description={t('coworkerSetup.fields.resetConfirm.description')}
                                confirmLabel={t('coworkerSetup.fields.resetConfirm.confirm')}
                                cancelLabel={t('cancel')}
                                confirmVariant="default"
                                onConfirm={useDefaultTemplate}
                            >
                                {resetButton}
                            </ConfirmDialog>
                        ) : (
                            resetButton
                        ))}
                </div>
            )}
        </div>
    )
}
