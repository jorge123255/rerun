import type { ControlSection } from '@/components/control-center/types'
import { buildControlCommands } from '@/lib/control-center/commands'
import { paritySemanticKey } from '@/lib/desktop/control-center-parity/commands'

export function originalControlCommand(id: string, darkTheme: boolean) {
    return buildControlCommands({ isSandbox: false, apiEntitled: false, needsMachineReason: null, assistantReady: true, hasChangelog: true, darkTheme })
        .find(command => command.id === paritySemanticKey(id))
}

/** Keep canonical callbacks and IDs; align known global labels to the original catalog. */
export function originalControlLabels(sections: ControlSection[], darkTheme: boolean): ControlSection[] {
    return sections.map(section => ({ ...section, rows: section.rows.map(row => {
        const original = originalControlCommand(row.id, darkTheme)
        return original && row.leading.kind !== 'assistant' ? { ...row, label: original.label } : row
    }) }))
}
