'use client'

import { CustomOptionRow, OptionRow } from '@rerun/ui/chat'
import type { TemplateCategory } from '@rerun/contracts'
import { useState } from 'react'

import { Field } from '@/components/ui/field'
import { INTAKE_INDUSTRIES, type IntakeDraft } from '@/lib/desktop/foreman-intake'
import { DesktopIntakeField } from './DesktopIntakeField'

type Props = {
    draft: IntakeDraft
    disabled?: boolean
    onChange: (patch: Partial<IntakeDraft>) => void
    onChoose: (industry: TemplateCategory) => void
    onEnter: () => void
}

export function DesktopIntakeIndustryStep({ draft, disabled, onChange, onChoose, onEnter }: Props) {
    const [custom, setCustom] = useState(!!draft.industryLabel)

    return (
        <Field label="Industry">
            <div className="-mx-1">
                <div className="grid grid-cols-2 gap-x-1 gap-y-0.5 max-sm:grid-cols-1">
                    {INTAKE_INDUSTRIES.map((option, index) => (
                        <OptionRow
                            key={option.value}
                            index={index}
                            label={option.label}
                            selected={!custom && draft.industry === option.value}
                            disabled={disabled}
                            onChoose={() => {
                                setCustom(false)
                                onChoose(option.value)
                            }}
                        />
                    ))}
                    <CustomOptionRow
                        open={custom}
                        onOpen={() => {
                            setCustom(true)
                            onChange({ industry: null })
                        }}
                        label="Other"
                        className="col-span-2 max-sm:col-span-1"
                    >
                        <DesktopIntakeField
                            autoFocus
                            value={draft.industryLabel}
                            disabled={disabled}
                            placeholder="Bakery, dental practice, gym…"
                            onChange={industryLabel => onChange({ industryLabel, industry: null })}
                            onEnter={onEnter}
                        />
                    </CustomOptionRow>
                </div>
            </div>
        </Field>
    )
}
