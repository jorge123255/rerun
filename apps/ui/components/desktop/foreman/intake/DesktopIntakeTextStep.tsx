'use client'

import { useId } from 'react'

import { Field } from '@/components/ui/field'
import { DesktopIntakeField } from './DesktopIntakeField'

export function DesktopIntakeTextStep({
    label,
    value,
    placeholder,
    disabled,
    autoFocus = true,
    onChange,
    onEnter,
}: {
    label: string
    value: string
    placeholder: string
    disabled?: boolean
    autoFocus?: boolean
    onChange: (value: string) => void
    onEnter: () => void
}) {
    const id = useId()
    return (
        <Field label={label} htmlFor={id}>
            <div className="flex items-center gap-2.5 rounded-md border border-border bg-background px-2.5 py-2">
                <DesktopIntakeField id={id} autoFocus={autoFocus} value={value} disabled={disabled} placeholder={placeholder} onChange={onChange} onEnter={onEnter} />
            </div>
        </Field>
    )
}
