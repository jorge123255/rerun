'use client'

import { Field } from '@/components/ui/field'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { desktopPresets, type DesktopCustomPreset } from '@/lib/desktop/custom-providers'

const OTHER = 'other'

type Props = {
    id: string
    selected: DesktopCustomPreset['id'] | null
    onPick: (preset: DesktopCustomPreset | null) => void
}

/** Picking one fills in what it already knows: its name and its address. */
export function DesktopCustomPresetPicker({ id, selected, onPick }: Props) {
    const presets = desktopPresets()
    const pick = (value: string) => onPick(presets.find(preset => preset.id === value) ?? null)
    return (
        <Field label="Server" htmlFor={id}>
            <Select value={selected ?? OTHER} onValueChange={pick}>
                <SelectTrigger id={id} className="h-8 w-full text-sm">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    {presets.map(preset => (
                        <SelectItem key={preset.id} value={preset.id}>{preset.label}</SelectItem>
                    ))}
                    <SelectItem value={OTHER}>Other</SelectItem>
                </SelectContent>
            </Select>
        </Field>
    )
}
