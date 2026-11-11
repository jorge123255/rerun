import type { DesktopMessages } from '@/lib/desktop/locale'
import type { ControlSection } from '@/components/control-center/types'
import { buildControlCommands } from '@/lib/control-center/commands'
import { paritySemanticKey } from '@/lib/desktop/control-center-parity/commands'

export function originalControlCommand(id: string, darkTheme: boolean) {
    return buildControlCommands({ isSandbox: false, apiEntitled: false, needsMachineReason: null, assistantReady: true, hasChangelog: true, darkTheme })
        .find(command => command.id === paritySemanticKey(id))
}

/** Keep canonical callbacks and IDs; align known global labels to the original catalog. */
export function originalControlLabels(sections: ControlSection[], darkTheme: boolean, copy?: ControlCenterCopy): ControlSection[] {
    return sections.map(section => ({ ...section, rows: section.rows.map(row => {
        const original = originalControlCommand(row.id, darkTheme)
        if (row.leading.kind === 'assistant') return copy ? { ...row, label: copy.askRerun } : row
        const label = localizedControlLabel(row.id, original?.label ?? row.label, darkTheme, copy)
        return label === row.label ? row : { ...row, label }
    }) }))
}

export type ControlCenterCopy = DesktopMessages['controlCenter']

export function localizedControlLabel(id: string, fallback: string, darkTheme: boolean, copy?: ControlCenterCopy): string {
    if (!copy) return fallback
    const key = paritySemanticKey(id)
    if (key === 'toggle_theme') return darkTheme ? copy.commands.toggle_theme_light : copy.commands.toggle_theme_dark
    if (Object.hasOwn(copy.commands, key)) return copy.commands[key as keyof typeof copy.commands]
    if (Object.hasOwn(copy.localCommands, key)) return copy.localCommands[key as keyof typeof copy.localCommands]
    return fallback
}
