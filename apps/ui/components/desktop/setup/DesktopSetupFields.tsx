'use client'

import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { MarkdownTextarea } from '@/components/ui/markdown-textarea'
import { Segmented } from '@/components/ui/segmented'
import { Wand2 } from '@/lib/icons'

export type DesktopSetupDraft = { required: boolean | null; prompt: string }

const CHOICES = [
    { value: 'yes', label: 'Yes' },
    { value: 'no', label: 'No' },
]

export function DesktopSetupFields({ value, defaultPrompt, onChange, disabled }: {
    value: DesktopSetupDraft
    defaultPrompt: string
    onChange: (next: DesktopSetupDraft) => void
    disabled?: boolean
}) {
    const prompt = value.prompt.trim()
    const isDefault = prompt === defaultPrompt.trim()
    const useDefaultTemplate = () => onChange({ ...value, prompt: defaultPrompt })

    const resetButton = (
        <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={prompt ? undefined : useDefaultTemplate} className="self-start">
            <Wand2 className="mr-1.5 size-3.5" />
            {prompt ? 'Reset to the default template' : 'Use the default template'}
        </Button>
    )

    return (
        <div className="flex flex-col gap-3">
            <Field label="Does this coworker need to be configured after install?" helperText="Answer before including this coworker in a private template.">
                <Segmented
                    options={CHOICES}
                    value={value.required === null ? '' : value.required ? 'yes' : 'no'}
                    onChange={next => {
                        const required = next === 'yes'
                        onChange({ required, prompt: required && !prompt ? defaultPrompt : value.prompt })
                    }}
                    className={disabled ? 'pointer-events-none opacity-60' : undefined}
                />
            </Field>

            {value.required === true && (
                <Field label="Install instructions" helperText="Written to the coworker, not to the user: it reads this and walks them through it in the chat.">
                    <div className="flex flex-col gap-1.5">
                        <MarkdownTextarea
                            dialogTitle="Edit the install instructions"
                            disabled={disabled}
                            value={value.prompt}
                            onChange={prompt => onChange({ ...value, prompt })}
                            placeholder={defaultPrompt}
                            className="min-h-40 font-mono text-xs"
                        />
                        {!isDefault &&
                            (prompt ? (
                                <ConfirmDialog
                                    title="Reset to the default template?"
                                    description="What is written here is replaced by the default instructions. This cannot be undone."
                                    confirmLabel="Reset"
                                    confirmVariant="default"
                                    onConfirm={useDefaultTemplate}
                                >
                                    {resetButton}
                                </ConfirmDialog>
                            ) : (
                                resetButton
                            ))}
                    </div>
                </Field>
            )}
        </div>
    )
}
