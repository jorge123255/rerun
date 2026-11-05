'use client'

import { Field } from '@/components/ui/field'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
    DESKTOP_TRIGGER_AGENT_DEFAULT,
    decodeTriggerRunModelPick,
    encodeTriggerRunModelPick,
    type DesktopTriggerRunModelCatalog,
    type DesktopTriggerRunModelPick,
} from '@/lib/desktop/triggers'
import { useMemo } from 'react'

type Props = {
    id: string
    value: DesktopTriggerRunModelPick
    onChange: (pick: DesktopTriggerRunModelPick) => void
    catalog: DesktopTriggerRunModelCatalog
    helperText?: string
    disabled?: boolean
}

/** Original RunModelField interactions via injected local catalog — no free-text model string, no hosted billing bypass. */
export function DesktopTriggerRunModelField({ id, value, onChange, catalog, helperText, disabled }: Props) {
    const orphan = useMemo(() => {
        if (!value.model) return null
        const known = catalog.availableGroups.some(g => g.connectionId === value.connectionId && g.models.some(m => m.id === value.model))
        return known ? null : { connectionId: value.connectionId, model: value.model }
    }, [catalog.availableGroups, value])

    if (!catalog.available) {
        return (
            <Field
                label="Model"
                helperText={catalog.unavailableReason ?? 'Local model catalog is unavailable for Triggers. This trigger follows the coworker model until root wires the catalog.'}
            >
                <p className="flex min-h-8 items-center rounded-md border border-dashed border-input px-3 text-xs text-muted-foreground">
                    Follow coworker model (catalog unavailable)
                </p>
            </Field>
        )
    }

    const agentDefaultLabel = catalog.agentModelLabel
        ? `Coworker default · ${catalog.agentModelLabel}`
        : 'Coworker default'
    const triggerLabel = value.model
        ? (catalog.availableGroups.flatMap(g => g.models).find(m => m.id === value.model)?.label ?? value.model)
        : agentDefaultLabel

    return (
        <Field
            label="Model"
            htmlFor={id}
            helperText={helperText ?? 'The model this trigger runs under when it fires. Requires the provider to be available on this Mac. Null inherits the coworker model.'}
        >
            <Select
                value={encodeTriggerRunModelPick(value)}
                disabled={disabled}
                onValueChange={encoded => {
                    const next = decodeTriggerRunModelPick(encoded)
                    const locked = catalog.availableGroups
                        .find(g => g.connectionId === next.connectionId)
                        ?.models.find(m => m.id === next.model)?.locked
                    // Locked/premium models stay unselectable here — root billing unlock is out of scope.
                    if (locked) return
                    onChange(next)
                }}
            >
                <SelectTrigger id={id} className="h-8 w-full text-sm">
                    <SelectValue placeholder="Select a model">{triggerLabel}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                    <SelectGroup>
                        <SelectItem value={DESKTOP_TRIGGER_AGENT_DEFAULT}>{agentDefaultLabel}</SelectItem>
                    </SelectGroup>
                    {catalog.availableGroups.map(group => (
                        <SelectGroup key={group.connectionId}>
                            <SelectLabel>{group.label}</SelectLabel>
                            {group.models.map(m => (
                                <SelectItem key={m.id} value={encodeTriggerRunModelPick({ connectionId: group.connectionId, model: m.id })} disabled={m.locked}>
                                    {m.label}{m.locked ? ' (unavailable)' : ''}
                                </SelectItem>
                            ))}
                        </SelectGroup>
                    ))}
                    {orphan && orphan.model && (
                        <SelectGroup>
                            <SelectLabel>Current</SelectLabel>
                            <SelectItem value={encodeTriggerRunModelPick(orphan)}>{orphan.model}</SelectItem>
                        </SelectGroup>
                    )}
                </SelectContent>
            </Select>
        </Field>
    )
}
