'use client'

import { Field } from '@/components/ui/field'
import { MarkdownTextarea } from '@/components/ui/markdown-textarea'
import { Segmented } from '@/components/ui/segmented'
import type { DesktopTemplateSetup } from './types'

const CHOICES = [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]

export function DesktopTemplateSetupFields({ value, disabled = false, onChange }: {
    value: DesktopTemplateSetup
    disabled?: boolean
    onChange: (next: DesktopTemplateSetup) => void
}) {
    return <div className="flex flex-col gap-3">
        <Field label="Does this coworker need to be configured after install?" helperText="Answer once. Each imported coworker starts with its own pending setup and empty chat.">
            <Segmented
                options={CHOICES}
                value={value.required === null ? '' : value.required ? 'yes' : 'no'}
                onChange={next => onChange({ ...value, required: next === 'yes' })}
                className={disabled ? 'pointer-events-none opacity-60' : undefined}
            />
        </Field>
        {value.required === true && <Field label="Install instructions" helperText="Written to the coworker, not to the user. Review private prose yourself; it is not automatically stripped.">
            <MarkdownTextarea
                dialogTitle="Edit the install instructions"
                disabled={disabled}
                value={value.prompt}
                onChange={prompt => onChange({ ...value, prompt })}
                placeholder="Explain the local information the imported coworker should request."
                className="min-h-40 font-mono text-xs"
            />
        </Field>}
    </div>
}
