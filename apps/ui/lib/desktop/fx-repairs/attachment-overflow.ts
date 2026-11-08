import { desktopImageKindForName } from '../composer-image'
import type { DesktopDocumentAddResult } from '../document-attachments/plan-document-add'

export type FxAttachmentKind = 'text' | 'image' | 'document'
export function fxAttachmentKind(file: Pick<File, 'name'>): FxAttachmentKind {
    return desktopImageKindForName(file.name) ? 'image' : /\.(txt|md)$/i.test(file.name) ? 'text' : 'document'
}

/** Candidates, never claimed imports: existing per-kind admission owns content and remaining budgets. */
export function planFxAttachmentBatch<T extends Pick<File, 'name'>>(files: readonly T[]): { kind: FxAttachmentKind; files: T[] }[] {
    const groups: { kind: FxAttachmentKind; files: T[] }[] = []
    for (const file of files) {
        const kind = fxAttachmentKind(file), last = groups[groups.length - 1]
        if (last?.kind === kind) last.files.push(file)
        else groups.push({ kind, files: [file] })
    }
    return groups
}

/** Use actual admission rejections/outcomes, including capacity overflow, not a guessed batch cap. */
export function formatFxAttachmentRejections(rows: readonly { name: string; message: string }[]): string[] {
    return rows.map(row => `${JSON.stringify(row.name)}: ${row.message}`)
}
export function formatFxDocumentRejections(result: DesktopDocumentAddResult): string[] {
    return formatFxAttachmentRejections(result.outcomes.filter(outcome => outcome.status === 'rejected'))
}
