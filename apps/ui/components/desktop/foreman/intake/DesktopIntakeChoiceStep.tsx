'use client'

import { CustomOptionRow, OptionRow } from '@rerun/ui/chat'
import { ScrollFade } from '@rerun/ui/primitives'
import { useState } from 'react'

import { Field } from '@/components/ui/field'
import { DesktopIntakeField } from './DesktopIntakeField'

type Props = {
    label: string
    options: string[]
    value: string
    placeholder: string
    disabled?: boolean
    onChange: (value: string) => void
    onChoose: (value: string) => void
    onEnter: () => void
}

export function DesktopIntakeChoiceStep({ label, options, value, placeholder, disabled, onChange, onChoose, onEnter }: Props) {
    const [custom, setCustom] = useState(!!value && !options.includes(value))

    return (
        <Field label={label}>
            <ScrollFade className="-mx-1 max-h-64 max-sm:max-h-48">
                <div className="space-y-0.5">
                    {options.map((option, index) => (
                        <OptionRow
                            key={option}
                            index={index}
                            label={option}
                            selected={!custom && value === option}
                            disabled={disabled}
                            onChoose={() => {
                                setCustom(false)
                                onChoose(option)
                            }}
                        />
                    ))}
                    <CustomOptionRow
                        open={custom}
                        onOpen={() => {
                            setCustom(true)
                            onChange('')
                        }}
                    >
                        <DesktopIntakeField autoFocus value={value} disabled={disabled} placeholder={placeholder} onChange={onChange} onEnter={onEnter} />
                    </CustomOptionRow>
                </div>
            </ScrollFade>
        </Field>
    )
}
